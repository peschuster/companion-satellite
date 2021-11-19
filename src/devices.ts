import { CompanionSatelliteClient } from './client'
import { listStreamDecks, openStreamDeck } from 'elgato-stream-deck'
import * as usbDetect from 'usb-detection'
// import EventEmitter = require('events')
import { CardGenerator } from './cards'
import { listXencelabsQuickKeys, openXencelabsQuickKeys, WheelEvent } from '@xencelabs-quick-keys/node'
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
		const dev2 = this.devices.get(dev.serialNumber)
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
			this.client.addDevice(device.deviceId, device.productName, device.getRegisterProps())

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

	private tryAddStreamdeck(path: string, serial: string) {
		if (!this.devices.has(serial)) {
			console.log(`adding new device: ${path}`)
			console.log(`existing = ${JSON.stringify(Array.from(this.devices.keys()))}`)

			try {
				const sd = openStreamDeck(path, { resetToLogoOnExit: true })
				const serial = sd.getSerialNumber()

				const devInfo = new StreamDeckWrapper(serial, sd, this.cardGenerator)

				this.showNewDevice(devInfo)

				this.devices.set(serial, devInfo)
				this.client.addDevice(serial, devInfo.productName, devInfo.getRegisterProps())

				console.log('Registering key events for ' + serial)
				sd.on('down', (key) => this.client.keyDown(serial, key))
				sd.on('up', (key) => this.client.keyUp(serial, key))

				sd.on('error', (e) => {
					console.error('device error', e)
				})
			} catch (e) {
				console.log(`Open "${path}" failed: ${e}`)
			}
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
		try {
			const deviceId = this.getAutoId(path, 'xencelabs-quick-keys')
			if (!this.devices.has(deviceId)) {
				console.log(`adding new device: ${deviceId}`)
				console.log(`existing = ${JSON.stringify(Array.from(this.devices.keys()))}`)

				const surface = await openXencelabsQuickKeys(path)
				const devInfo = new QuickKeysWrapper(deviceId, surface)

				this.showNewDevice(devInfo)

				this.devices.set(deviceId, devInfo)
				this.client.addDevice(deviceId, devInfo.productName, devInfo.getRegisterProps())

				console.log('Registering key events for ' + deviceId)

				const keyToCompanion = (k: number) => {
					if (k >= 0 && k < 4) return k + 1
					if (k >= 4 && k < 8) return k + 3
					if (k === 8) return 0
					if (k === 9) return 5
					return null
				}
				surface.on('down', (key) => {
					const k = keyToCompanion(key)
					if (k !== null) {
						this.client.keyDown(deviceId, k)
					}
				})
				surface.on('up', (key) => {
					const k = keyToCompanion(key)
					if (k !== null) {
						this.client.keyUp(deviceId, k)
					}
				})
				surface.on('wheel', (ev) => {
					switch (ev) {
						case WheelEvent.Left:
							this.client.keyUp(deviceId, 11)
							break
						case WheelEvent.Right:
							this.client.keyDown(deviceId, 11)
							break
					}
				})

				surface.on('error', (e) => {
					console.error('device error', e)
				})
			}
		} catch (e) {
			console.log(`Open "${path}" failed: ${e}`)
		}
	}

	private async showNewDevice(dev: WrappedDevice): Promise<void> {
		// Start with blanking it
		await dev.blankDevice()

		await dev.showStatus(this.client.host, this.statusString)
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
