import { CompanionSatelliteClient } from './client'
import { listStreamDecks, openStreamDeck, StreamDeck } from 'elgato-stream-deck'
import * as usbDetect from 'usb-detection'
// import EventEmitter = require('events')
import { CardGenerator } from './cards'
import { listXencelabsQuickKeys, openXencelabsQuickKeys, XencelabsQuickKeys } from '@xencelabs-quick-keys/node'
import { DeviceId, WrappedDevice } from './device-types/api'
import { StreamDeckWrapper } from './device-types/streamdeck'
import { QuickKeysWrapper } from './device-types/xencelabs-quick-keys'

const autoIdMap = new Map<string, string>()

export class DeviceManager {
	private readonly devices: Map<DeviceId, WrappedDevice>
	private readonly client: CompanionSatelliteClient
	private readonly cardGenerator: CardGenerator

	private statusString: string

	constructor(client: CompanionSatelliteClient) {
		this.client = client
		this.devices = new Map()
		this.cardGenerator = new CardGenerator()

		usbDetect.startMonitoring()
		usbDetect.on('add:4057', (dev) => this.foundDevice(dev))
		usbDetect.on('remove:4057', (dev) => this.removeDevice(dev))

		this.statusString = 'Connecting'

		this.scanDevices()

		client.on('connected', () => {
			console.log('connected')

			this.showStatusCard('Connected')

			this.registerAll()
		})
		client.on('disconnected', () => {
			console.log('disconnected')

			this.showStatusCard('Disconnected')
		})
		client.on('ipChange', () => {
			this.showStatusCard()
		})

		client.on('brightness', async (d) => {
			try {
				const dev = this.getDeviceInfo(d.deviceId)
				await dev.setBrightness(d.percent)
			} catch (e) {
				console.error(`Set brightness: ${e}`)
			}
		})
		client.on('clearDeck', async (d) => {
			try {
				const dev = this.getDeviceInfo(d.deviceId)
				await dev.blankDevice()
			} catch (e) {
				console.error(`Set brightness: ${e}`)
			}
		})
		client.on('draw', async (d) => {
			try {
				const dev = this.getDeviceInfo(d.deviceId)
				await dev.draw(d)
			} catch (e) {
				console.error(`Draw: ${e}`)
			}
		})
		client.on('newDevice', async (d) => {
			try {
				const dev = this.devices.get(d.deviceId)
				if (dev) {
					await dev.deviceAdded()
				} else {
					throw new Error(`Device missing: ${d.deviceId}`)
				}
			} catch (e) {
				console.error(`Setup device: ${e}`)
			}
		})
	}

	public async close(): Promise<void> {
		usbDetect.stopMonitoring()

		// Close all the devices
		await Promise.allSettled(Array.from(this.devices.values()).map((d) => d.close()))
	}

	private getDeviceInfo(deviceId: string): WrappedDevice {
		const dev = this.devices.get(deviceId)
		if (!dev) throw new Error(`Missing device for serial: "${deviceId}"`)
		return dev
	}

	private foundDevice(dev: usbDetect.Device): void {
		console.log('Found a device', dev)

		// most of the time it is available now
		this.scanDevices()
		// sometimes it ends up delayed
		setTimeout(() => this.scanDevices(), 1000)
	}

	private removeDevice(dev: usbDetect.Device): void {
		console.log('Lost a device', dev)
		let dev2 = this.devices.get(dev.serialNumber)
		// TODO - this won't work for quickkeys, and is brittle for streamdecks..

		if (dev2) {
			// cleanup
			this.devices.delete(dev.serialNumber)
			this.client.removeDevice(dev.serialNumber)

			dev2.close().catch(() => {
				// Ignore
			})
		}
	}

	public registerAll(): void {
		for (const [_, device] of this.devices.entries()) {
			// If it is already in the process of initialising, core will give us back the same id twice, so we dont need to track it
			// if (!devices2.find((d) => d[1] === serial)) { // TODO - do something here?

			// Indicate on device
			device.showStatus(this.client.host, this.statusString)

			// Re-init device
			if (device.ready) {
				this.client.addDevice(device.deviceId, device.productName, device.getRegisterProps())
			}

			// }
		}

		this.scanDevices()
	}

	public scanDevices(): void {
		for (const device of listStreamDecks()) {
			if (device.serialNumber) {
				this.tryAddStreamdeck(device.path, device.serialNumber)
			}
		}
		for (const device of listXencelabsQuickKeys()) {
			this.tryAddQuickKeys(device.path)
		}
	}

	private async tryAddStreamdeck(path: string, serial: string) {
		let sd: StreamDeck | undefined
		try {
			if (!this.devices.has(serial)) {
				console.log(`adding new device: ${path}`)
				console.log(`existing = ${JSON.stringify(Array.from(this.devices.keys()))}`)

				sd = openStreamDeck(path, { resetToLogoOnExit: true })
				sd.on('error', (e) => {
					console.error('device error', e)
				})

				const devInfo = new StreamDeckWrapper(serial, sd, this.cardGenerator)
				await this.tryAddDeviceInner(serial, devInfo)
			}
		} catch (e) {
			console.log(`Open "${path}" failed: ${e}`)
			if (sd) sd.close() //.catch((e) => null)
		}
	}

	private getAutoId(path: string, prefix: string): string {
		const val = autoIdMap.get(path)
		if (val) return val

		const nextId = autoIdMap.size + 1
		const val2 = `${prefix}-${nextId.toString().padStart(3, '0')}`
		autoIdMap.set(path, val2)
		return val2
	}

	private async tryAddQuickKeys(path: string) {
		let surface: XencelabsQuickKeys | undefined
		try {
			const deviceId = this.getAutoId(path, 'xencelabs-quick-keys')
			if (!this.devices.has(deviceId)) {
				console.log(`adding new device: ${deviceId}`)
				console.log(`existing = ${JSON.stringify(Array.from(this.devices.keys()))}`)

				// TODO - this is race prone..
				surface = await openXencelabsQuickKeys(path)
				surface.on('error', (e) => {
					console.error('device error', e)
				})

				const devInfo = new QuickKeysWrapper(deviceId, surface)
				await this.tryAddDeviceInner(deviceId, devInfo)
			}
		} catch (e) {
			console.log(`Open "${path}" failed: ${e}`)
			if (surface) surface.close().catch((e) => null)
		}
	}

	private async tryAddDeviceInner(deviceId: string, devInfo: WrappedDevice): Promise<void> {
		await devInfo.initDevice(this.client, this.statusString)

		this.devices.set(deviceId, devInfo)

		if (devInfo.ready) {
			this.client.addDevice(deviceId, devInfo.productName, devInfo.getRegisterProps())
		}
	}

	private showStatusCard(status?: string): void {
		if (status !== undefined) {
			this.statusString = status
		}

		for (const dev of this.devices.values()) {
			dev.showStatus(this.client.host, this.statusString)
		}
	}
}
