## Companion Satellite

[![License](https://img.shields.io/github/license/bitfocus/companion-satellite)](https://github.com/Julusian/companion-satellite/blob/master/LICENSE)
[![Version](https://img.shields.io/github/v/release/bitfocus/companion-satellite)](https://github.com/Julusian/companion-satellite/releases)

A small application to allow for connecting a streamdeck to [Bitfocus Companion](https://github.com/bitfocus/companion) over a network.

Companion 2.1.2 and newer are supported

Each device will appear in companion as its own 'satellite' device, and can be configured as if they are local.

Note: This connects over the satellite device api which uses port TCP 37133.

## Running

### Electron

This application can be built with electron to provide a minimal ui and to allow for minimising to the system tray.
You can right click the tray icon to:

- Set the ip address of the companion instance to connect to
- Force a manual scan for devices. This is done automatically when a new device is detected, but it can sometimes miss some

To manually build the latest version for your machine:

- `yarn install`
- `yarn dist`
- Locate the output under `electron-output/`

### Headless

It can be built and run as a systemd service on a pi or other linux machine

To prepare the application, after cloning:

- `yarn install`
- `yarn build`

An example systemd unit (make sure to update the paths and companion ip as appropriate):

```
[Unit]
Description=Bitfocus Companion Satellite
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/companion-satellite
ExecStart=node /home/pi/companion-satellite/dist/main.js 192.168.0.1
Restart=on-failure
KillSignal=SIGINT
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

## Development

NodeJS 12.16.3 and 14 are supported

### Electron

1. Install the dependencies `yarn install`
1. Ensure the electron dependencies are installed `yarn electron-rebuild`
1. Run it `yarn dev-electron`

You can package for electron with `yarn dist`.  
Building for another platform has not been tested.

### Headless

1. If you are running this after either running in electron, or packaging for electron, it is best to remove the node_modules folder and rerun `yarn install`
1. Run it `yarn dev 127.0.0.1` substituting in your companion instance ip address
