import exitHook = require('exit-hook')
import * as meow from 'meow'
import { CompanionSatelliteClientV2 } from './clientv2'
import { DeviceManager } from './devices'

const cli = meow(
	`
	Usage
	  $ companion-satellite hostname

	Examples
	  $ companion-satellite 192.168.1.100
`,
	{}
)

if (cli.input.length === 0) {
	cli.showHelp(0)
}

console.log('Starting')

const client = new CompanionSatelliteClientV2({ debug: true })
const devices = new DeviceManager(client)

client.on('log', (l) => console.log(l))
client.on('error', (e) => console.error(e))

exitHook(() => {
	console.log('Exiting')
	client.disconnect()
	devices.close()
})

client.connect(cli.input[0])

devices
