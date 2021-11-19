import { ClientDrawProps, CompanionSatelliteClient, DeviceRegisterProps } from './client'
import { listStreamDecks, openStreamDeck, StreamDeck } from 'elgato-stream-deck'
import * as usbDetect from 'usb-detection'
import { ImageWriteQueue } from './writeQueue'
import sharp = require('sharp')
// import EventEmitter = require('events')
import { CardGenerator } from './cards'
import {
	listXencelabsQuickKeys,
	openXencelabsQuickKeys,
	WheelEvent,
	XencelabsQuickKeysDisplayBrightness,
	XencelabsQuickKeysDisplayOrientation,
	XencelabsQuickKeysWheelSpeed,
} from '@xencelabs-quick-keys/node'
import { XencelabsQuickKeys } from '@xencelabs-quick-keys/node'

type DeviceId = string

interface WrappedDevice {
	readonly deviceId: DeviceId
	readonly productName: string

	getRegisterProps(): DeviceRegisterProps

	close(): Promise<void>

	deviceAdded(): Promise<void>

	setBrightness(percent: number): Promise<void>

	blankDevice(): Promise<void>

	draw(data: ClientDrawProps): Promise<void>

	showStatus(hostname: string, status: string): Promise<void>
}

class StreamDeckWrapper implements WrappedDevice {
	readonly #cardGenerator: CardGenerator
	readonly #deck: StreamDeck
	readonly #deviceId: string

	#queueOutputId: number
	#queue: ImageWriteQueue | undefined

	public get deviceId(): string {
		return this.#deviceId
	}
	public get productName(): string {
		return `Satellite StreamDeck: ${this.#deck.MODEL}`
	}

	public constructor(deviceId: string, deck: StreamDeck, cardGenerator: CardGenerator) {
		this.#deck = deck
		this.#deviceId = deviceId
		this.#cardGenerator = cardGenerator

		this.#queueOutputId = 0

		if (this.#deck.ICON_SIZE !== 72) {
			this.#queue = new ImageWriteQueue(async (key: number, buffer: Buffer) => {
				const outputId = this.#queueOutputId
				let newbuffer: Buffer | null = null
				try {
					newbuffer = await sharp(buffer, { raw: { width: 72, height: 72, channels: 3 } })
						.resize(this.#deck.ICON_SIZE, this.#deck.ICON_SIZE)
						.raw()
						.toBuffer()
				} catch (e) {
					console.error(`device(${deviceId}): scale image failed: ${e}`)
					return
				}

				// Check if generated image is still valid
				if (this.#queueOutputId === outputId) {
					try {
						this.#deck.fillImage(key, newbuffer)
					} catch (e_1) {
						console.error(`device(${deviceId}): fillImage failed: ${e_1}`)
					}
				}
			})
		}
	}

	getRegisterProps(): DeviceRegisterProps {
		return {
			keysTotal: this.#deck.NUM_KEYS,
			keysPerRow: this.#deck.KEY_COLUMNS,
			bitmaps: true,
			colours: false,
			text: false,
		}
	}

	async close(): Promise<void> {
		this.#queue?.abort()
		this.#deck.close()
	}
	async deviceAdded(): Promise<void> {
		this.#queueOutputId++
	}
	async setBrightness(percent: number): Promise<void> {
		this.#deck.setBrightness(percent)
	}
	async blankDevice(): Promise<void> {
		this.#deck.clearAllKeys()
	}
	async draw(d: ClientDrawProps): Promise<void> {
		if (d.image) {
			if (this.#queue) {
				this.#queue.queue(d.keyIndex, d.image)
			} else {
				this.#deck.fillImage(d.keyIndex, d.image)
			}
		} else {
			throw new Error(`Cannot draw for Streamdeck without image`)
		}
	}
	async showStatus(hostname: string, status: string): Promise<void> {
		// abort and discard current operations
		this.#queue?.abort()
		this.#queueOutputId++

		const outputId = this.#queueOutputId
		this.#cardGenerator
			.generateBasicCard(this.#deck, hostname, status)
			.then((buffer) => {
				if (outputId === this.#queueOutputId) {
					// still valid
					this.#deck.fillPanel(buffer, { format: 'rgba' })
				}
			})
			.catch((e) => {
				console.error(`Failed to fill device`, e)
			})
	}
}

class QuickKeysWrapper implements WrappedDevice {
	readonly #surface: XencelabsQuickKeys
	readonly #deviceId: string

	#statusTimer: NodeJS.Timer | undefined

	public get deviceId(): string {
		return this.#deviceId
	}
	public get productName(): string {
		return 'Xencelabs Quick Keys'
	}

	public constructor(deviceId: string, surface: XencelabsQuickKeys) {
		this.#surface = surface
		this.#deviceId = deviceId
	}

	getRegisterProps(): DeviceRegisterProps {
		return {
			keysTotal: 12,
			keysPerRow: 6,
			bitmaps: false,
			colours: true,
			text: true,
		}
	}
	async close(): Promise<void> {
		this.stopStatusInterval()

		await this.#surface.close()
	}
	async deviceAdded(): Promise<void> {
		this.clearStatus()
	}
	async setBrightness(percent: number): Promise<void> {
		const opts = Object.values(XencelabsQuickKeysDisplayBrightness).filter(
			(k) => typeof k === 'number'
		) as XencelabsQuickKeysDisplayBrightness[]

		const perStep = 100 / (opts.length - 1)
		const step = Math.round(percent / perStep)

		await this.#surface.setDisplayBrightness(opts[step])
	}
	async blankDevice(): Promise<void> {
		await this.clearStatus()

		// Do some initial setup too
		await this.#surface.setWheelSpeed(XencelabsQuickKeysWheelSpeed.Normal) // TODO dynamic
		await this.#surface.setDisplayOrientation(XencelabsQuickKeysDisplayOrientation.Rotate0) // TODO dynamic
		await this.#surface.setSleepTimeout(0) // TODO dynamic

		await this.#surface.setWheelColor(0, 0, 0)

		for (let i = 0; i < 8; i++) {
			await this.#surface.setKeyText(i, '')
		}
	}
	async draw(data: ClientDrawProps): Promise<void> {
		await this.clearStatus()

		if (typeof data.text === 'string') {
			let keyIndex: number | null = null
			if (data.keyIndex >= 1 && data.keyIndex < 5) keyIndex = data.keyIndex - 1
			if (data.keyIndex >= 7 && data.keyIndex < 11) keyIndex = data.keyIndex - 3

			if (keyIndex !== null) {
				await this.#surface.setKeyText(keyIndex, data.text.substr(0, 8))
			}
		}
		if (data.color && data.keyIndex === 11) {
			const r = parseInt(data.color.substr(1, 2), 16)
			const g = parseInt(data.color.substr(3, 2), 16)
			const b = parseInt(data.color.substr(5, 2), 16)

			await this.#surface.setWheelColor(r, g, b)
		}
	}
	async showStatus(_hostname: string, status: string): Promise<void> {
		this.stopStatusInterval()

		const newMessage = status
		this.#statusTimer = setInterval(() => {
			// Update on an interval, as we cant set it unlimited
			this.#surface.showOverlayText(5, newMessage).catch((e) => {
				console.error(`Overlay failed: ${e}`)
			})
		}, 3000)

		await this.#surface.showOverlayText(5, newMessage)
	}

	private stopStatusInterval(): boolean {
		if (this.#statusTimer) {
			clearInterval(this.#statusTimer)
			this.#statusTimer = undefined

			return true
		}

		return false
	}
	private async clearStatus(msg?: string): Promise<void> {
		if (this.stopStatusInterval()) {
			await this.#surface.showOverlayText(1, msg ?? '')
		}
	}
}

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
