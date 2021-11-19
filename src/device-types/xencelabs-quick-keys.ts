import {
	XencelabsQuickKeys,
	XencelabsQuickKeysDisplayBrightness,
	XencelabsQuickKeysWheelSpeed,
	XencelabsQuickKeysDisplayOrientation,
} from '@xencelabs-quick-keys/node'
import { WrappedDevice, DeviceRegisterProps, DeviceDrawProps } from './api'

export class QuickKeysWrapper implements WrappedDevice {
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
