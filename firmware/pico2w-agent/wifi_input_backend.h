#pragma once

#include "switch_pro_driver.h"

// Start a local Wi-Fi access point and a UDP action listener on port 8765.
// The Pico remains the USB HID device; the host only sends action commands over
// Wi-Fi. This keeps the Mac and Switch USB roles separate.
void wifi_input_backend_init();

// Copy the latest controller state into out_state. The function also expires
// one-shot button presses after their requested duration.
void wifi_input_backend_snapshot(SwitchInputState* out_state);
