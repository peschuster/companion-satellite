import {
	XencelabsQuickKeys,
	XencelabsQuickKeysDisplayBrightness,
	XencelabsQuickKeysWheelSpeed,
	XencelabsQuickKeysDisplayOrientation,
	WheelEvent,
} from '@xencelabs-quick-keys/node'
import EventEmitter = require('eventemitter3')
import { CompanionSatelliteClient } from '../client'
import { WrappedDevice, DeviceRegisterProps, DeviceDrawProps, WrappedDeviceEvents } from './api'

export class QuickKeysWrapper extends EventEmitter<WrappedDeviceEvents> implements WrappedDevice {
	readonly #surface: XencelabsQuickKeys
	readonly #deviceId: string

	#statusTimer: NodeJS.Timer | undefined

	public get deviceId(): string {
		return this.#deviceId
	}
	public get productName(): string {
		return 'Xencelabs Quick Keys'
	}
	public get ready(): boolean {
		return true // TODO
	}

	public constructor(deviceId: string, surface: XencelabsQuickKeys) {
		super()

		this.#surface = surface
		this.#deviceId = deviceId

		surface.on('connected', () => this.emit('ready', true))
		surface.on('disconnected', () => this.emit('ready', false))
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
	async initDevice(client: CompanionSatelliteClient, status: string): Promise<void> {
		console.log('Registering key events for ' + this.deviceId)

		const keyToCompanion = (k: number) => {
			if (k >= 0 && k < 4) return k + 1
			if (k >= 4 && k < 8) return k + 3
			if (k === 8) return 0
			if (k === 9) return 5
			return null
		}
		this.#surface.on('down', (key) => {
			const k = keyToCompanion(key)
			if (k !== null) {
				client.keyDown(this.deviceId, k)
			}
		})
		this.#surface.on('up', (key) => {
			const k = keyToCompanion(key)
			if (k !== null) {
				client.keyUp(this.deviceId, k)
			}
		})
		this.#surface.on('wheel', (ev) => {
			switch (ev) {
				case WheelEvent.Left:
					client.keyUp(this.deviceId, 11)
					break
				case WheelEvent.Right:
					client.keyDown(this.deviceId, 11)
					break
			}
		})

		await this.#surface.setWheelSpeed(XencelabsQuickKeysWheelSpeed.Normal) // TODO dynamic
		await this.#surface.setDisplayOrientation(XencelabsQuickKeysDisplayOrientation.Rotate0) // TODO dynamic
		await this.#surface.setSleepTimeout(0) // TODO dynamic

		// Start with blanking it
		await this.blankDevice()

		await this.showStatus(client.host, status)
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

		await this.#surface.setWheelColor(0, 0, 0)

		for (let i = 0; i < 8; i++) {
			await this.#surface.setKeyText(i, '')
		}
	}
	async draw(data: DeviceDrawProps): Promise<void> {
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
