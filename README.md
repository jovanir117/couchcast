# Couchcast

A Chrome extension that sends the video on the current page to a Samsung smart TV (Tizen) over your home network. The TV plays it with its own player: smooth, full quality, and without mirroring your screen.

- **YouTube**: opens the video in the TV's YouTube app (DIAL), at the same second.
- **Other sites**: finds the video that is playing (iframes included) and hands it to the TV over DLNA. For HLS streams it picks the best quality from the start, and falls back through the other qualities when the TV refuses one.
- **No setup**: finds the TV on the network, and finds it again when the router gives it a new IP.
- **Remote**: pause, play, stop, volume, and turn the TV on.

> The interface is in Spanish.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, and pick this folder.
2. Open a page with a video, press play, and click the Couchcast icon.

## PC relay (optional)

Some sites only serve the video to a browser (they check the Referer, the Origin or cookies). The relay runs on your PC, fetches the video with the browser's headers and passes it to the TV untouched, with no transcoding. It also sends the Wake-on-LAN packet that turns the TV on from the popup.

```
node relay/relay.js              # listens on port 8723, local network only
node relay/relay.js --selftest
```

On Windows, `relay/iniciar.vbs` starts it hidden and restarts it if it dies; put a shortcut to it in the Startup folder to run it at login.

To turn the TV on from the popup, enable **Power on with mobile** on the TV (Settings › General › Network › Expert Settings), and turn the TV on once with the remote so the extension learns its MAC address.

## Limits

- DRM sites (Netflix, Disney+…) never expose a video file: use their TV app.
- Some sites only hand the video to Chrome itself (TLS fingerprinting); not even the relay can get it.
- Tested with a Samsung OLED running Tizen. Other DLNA TVs should play the video, but not report their state or wake up.

## License

MIT
