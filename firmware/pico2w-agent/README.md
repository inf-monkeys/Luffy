# Pico 2 W Jev controller firmware

This firmware makes a Pico 2 W enumerate as one wired Nintendo Switch Pro
Controller over USB. It starts a private Wi-Fi access point so the Mac can
send short actions without a second Bluetooth controller or a USB-UART
adapter.

## Current hardware path

```text
Mac Jev/Luffy -- Wi-Fi --> Pico 2 W -- USB device --> Switch dock USB host
```

The Pico access point is `Jev-Pico` with password `jev-pico-1234`. The UDP
listener is `192.168.4.1:8765`.

The action payload is JSON. Luffy sends a complete controller state. The
legacy single-button field is still accepted:

```json
{
  "action": {
    "buttons": ["A", "ZR"],
    "left_stick": {"x": 0.8, "y": 0.0},
    "right_stick": {"x": 0.0, "y": -0.25},
    "duration_ms": 120
  },
  "metadata": {"source": "agent"}
}
```

Supported buttons are `A`, `B`, `X`, `Y`, `L`, `R`, `ZL`, `ZR`, `PLUS`,
`MINUS`, `HOME`, `CAPTURE`, `L3`, `R3`, `UP`, `DOWN`, `LEFT`, `RIGHT`, and
`WAIT`. Multiple entries in `buttons` are held at the same time. Stick axes
are normalized to `-1..1`, with positive `y` meaning up. The firmware resets
all buttons and sticks to neutral after `duration_ms` (maximum 10 seconds).

The Switch Pro HID report also has motion and rumble fields, but this Pico 2 W
build has no IMU and does not implement rumble feedback. Motion remains neutral
and rumble is ignored until additional hardware and protocol support are added.

For a direct smoke test after connecting the Mac to the Pico hotspot:

```sh
printf '%s' '{"action":{"buttons":["A","ZR"],"left_stick":{"x":0.5,"y":0},"duration_ms":120}}' \
  | nc -u -w1 192.168.4.1 8765
```

The binary is built for `PICO_BOARD=pico2_w` with the `WIFI` input backend.

`switch-pico` and the Switch Pro descriptor implementation are retained as
the upstream hardware layer; the Wi-Fi action backend is the project-specific
input layer.
