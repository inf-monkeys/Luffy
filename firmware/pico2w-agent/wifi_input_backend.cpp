#include "wifi_input_backend.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>

#include "hardware/sync.h"
#include "dhcpserver.h"
#include "lwip/ip_addr.h"
#include "lwip/ip4_addr.h"
#include "lwip/pbuf.h"
#include "lwip/udp.h"
#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"

namespace {

constexpr uint16_t kUdpPort = 8765;
constexpr char kApSsid[] = "Jev-Pico";
constexpr char kApPassword[] = "jev-pico-1234";
constexpr size_t kMaxPacket = 256;

struct BackendState {
    SwitchInputState input{};
    absolute_time_t expiry{};
    bool has_expiry = false;
};

BackendState g_state;
udp_pcb* g_udp = nullptr;
dhcp_server_t g_dhcp{};

SwitchInputState neutral_input() {
    SwitchInputState state{};
    state.lx = SWITCH_PRO_JOYSTICK_MID;
    state.ly = SWITCH_PRO_JOYSTICK_MID;
    state.rx = SWITCH_PRO_JOYSTICK_MID;
    state.ry = SWITCH_PRO_JOYSTICK_MID;
    return state;
}

void set_button(SwitchInputState& state, const char* button) {
    if (strcmp(button, "WAIT") == 0) return;
    if (strcmp(button, "A") == 0) state.button_a = true;
    else if (strcmp(button, "B") == 0) state.button_b = true;
    else if (strcmp(button, "X") == 0) state.button_x = true;
    else if (strcmp(button, "Y") == 0) state.button_y = true;
    else if (strcmp(button, "L") == 0) state.button_l = true;
    else if (strcmp(button, "R") == 0) state.button_r = true;
    else if (strcmp(button, "ZL") == 0) state.button_zl = true;
    else if (strcmp(button, "ZR") == 0) state.button_zr = true;
    else if (strcmp(button, "PLUS") == 0) state.button_plus = true;
    else if (strcmp(button, "MINUS") == 0) state.button_minus = true;
    else if (strcmp(button, "HOME") == 0) state.button_home = true;
    else if (strcmp(button, "CAPTURE") == 0) state.button_capture = true;
    else if (strcmp(button, "L3") == 0) state.button_l3 = true;
    else if (strcmp(button, "R3") == 0) state.button_r3 = true;
    else if (strcmp(button, "UP") == 0) state.dpad_up = true;
    else if (strcmp(button, "DOWN") == 0) state.dpad_down = true;
    else if (strcmp(button, "LEFT") == 0) state.dpad_left = true;
    else if (strcmp(button, "RIGHT") == 0) state.dpad_right = true;
}

bool is_known_button(const char* button) {
    static constexpr const char* names[] = {
        "A", "B", "X", "Y", "L", "R", "ZL", "ZR", "PLUS", "MINUS",
        "HOME", "CAPTURE", "L3", "R3", "UP", "DOWN", "LEFT", "RIGHT", "WAIT",
    };
    for (const char* name : names) {
        if (strcmp(name, button) == 0) return true;
    }
    return false;
}

const char* skip_space(const char* cursor, const char* end) {
    while (cursor < end && std::isspace(static_cast<unsigned char>(*cursor))) {
        ++cursor;
    }
    return cursor;
}

bool parse_uint(const char*& cursor, const char* end, uint32_t& value) {
    cursor = skip_space(cursor, end);
    if (cursor >= end || !std::isdigit(static_cast<unsigned char>(*cursor))) {
        return false;
    }
    value = 0;
    while (cursor < end && std::isdigit(static_cast<unsigned char>(*cursor))) {
        value = std::min<uint32_t>(10000, value * 10 + (*cursor - '0'));
        ++cursor;
    }
    return true;
}

bool parse_button_token(const char*& cursor, const char* end, char* button,
                        size_t button_size) {
    cursor = skip_space(cursor, end);
    if (cursor >= end) return false;
    size_t length = 0;
    while (cursor < end && std::isalpha(static_cast<unsigned char>(*cursor))) {
        if (length + 1 >= button_size) return false;
        button[length++] = static_cast<char>(std::toupper(static_cast<unsigned char>(*cursor)));
        ++cursor;
    }
    // ZL/ZR, L3/R3 and PLUS/MINUS contain digits or are longer; accept the
    // digit suffix and let is_known_button validate the completed token.
    while (cursor < end && std::isdigit(static_cast<unsigned char>(*cursor))) {
        if (length + 1 >= button_size) return false;
        button[length++] = *cursor++;
    }
    button[length] = '\0';
    return length > 0;
}

bool parse_decimal(const char*& cursor, const char* end, float& value) {
    cursor = skip_space(cursor, end);
    char* number_end = nullptr;
    value = std::strtof(cursor, &number_end);
    if (number_end == cursor || number_end > end || !std::isfinite(value)) {
        return false;
    }
    cursor = number_end;
    return true;
}

uint16_t map_stick_axis(float value, bool invert) {
    value = std::max(-1.0f, std::min(1.0f, value));
    if (invert) value = -value;
    const float mapped = static_cast<float>(SWITCH_PRO_JOYSTICK_MID) +
                         value * 32768.0f;
    if (mapped <= 0.0f) return SWITCH_PRO_JOYSTICK_MIN;
    if (mapped >= 65535.0f) return SWITCH_PRO_JOYSTICK_MAX;
    return static_cast<uint16_t>(mapped + 0.5f);
}

bool parse_stick(const char* data, const char* end, const char* key,
                 uint16_t& x, uint16_t& y, bool& found) {
    const char* key_start = strstr(data, key);
    if (!key_start || key_start >= end) return true;
    found = true;

    const char* object_start = strchr(key_start, '{');
    if (!object_start || object_start >= end) return false;
    const char* object_end = strchr(object_start, '}');
    if (!object_end || object_end >= end) return false;

    auto parse_axis = [&](const char* axis, float& value) {
        const char* axis_start = strstr(object_start, axis);
        if (!axis_start || axis_start >= object_end) return false;
        const char* colon = strchr(axis_start, ':');
        if (!colon || colon >= object_end) return false;
        const char* cursor = colon + 1;
        return parse_decimal(cursor, object_end, value);
    };

    float x_value = 0.0f;
    float y_value = 0.0f;
    if (!parse_axis("\"x\"", x_value) || !parse_axis("\"y\"", y_value)) {
        return false;
    }
    x = map_stick_axis(x_value, false);
    // The host protocol uses positive Y for up. The Switch Pro driver's
    // signed 12-bit packing applies the opposite direction, so invert the
    // normalized host value at this boundary.
    y = map_stick_axis(y_value, true);
    return true;
}

bool parse_quoted_button(const char*& cursor, const char* end, char* button,
                         size_t button_size) {
    cursor = skip_space(cursor, end);
    if (cursor >= end || *cursor != '"') return false;
    ++cursor;
    size_t length = 0;
    while (cursor < end && *cursor != '"') {
        if (length + 1 >= button_size || !std::isalnum(static_cast<unsigned char>(*cursor))) {
            return false;
        }
        button[length++] = static_cast<char>(std::toupper(static_cast<unsigned char>(*cursor)));
        ++cursor;
    }
    if (cursor >= end || length == 0) return false;
    button[length] = '\0';
    ++cursor;
    return true;
}

bool parse_buttons_array(const char* data, const char* end,
                         SwitchInputState& state, bool& found) {
    const char* key_start = strstr(data, "\"buttons\"");
    if (!key_start || key_start >= end) return true;
    found = true;
    const char* array_start = strchr(key_start, '[');
    if (!array_start || array_start >= end) return false;
    const char* array_end = strchr(array_start, ']');
    if (!array_end || array_end >= end) return false;

    const char* cursor = array_start + 1;
    while (true) {
        cursor = skip_space(cursor, array_end);
        if (cursor == array_end) return true;
        if (cursor > array_end) return false;

        char button[16]{};
        if (!parse_quoted_button(cursor, array_end, button, sizeof(button)) ||
            !is_known_button(button)) {
            return false;
        }
        set_button(state, button);

        cursor = skip_space(cursor, array_end);
        if (cursor == array_end) return true;
        if (cursor < array_end && *cursor == ',') {
            ++cursor;
            continue;
        }
        if (cursor < array_end && *cursor == ']') return true;
        return false;
    }
}

bool parse_action(const char* data, size_t length, SwitchInputState& state,
                  uint32_t& duration_ms) {
    const char* cursor = data;
    const char* end = data + length;
    cursor = skip_space(cursor, end);
    state = neutral_input();

    // Compact protocol for the host: PRESS A 100
    if (static_cast<size_t>(end - cursor) >= 5 &&
        strncmp(cursor, "PRESS", 5) == 0) {
        cursor += 5;
        char button[16]{};
        if (!parse_button_token(cursor, end, button, sizeof(button)) ||
            !is_known_button(button)) {
            return false;
        }
        set_button(state, button);
        cursor = skip_space(cursor, end);
        if (!parse_uint(cursor, end, duration_ms)) duration_ms = 100;
        return true;
    }

    duration_ms = 100;
    const char* duration_key = strstr(data, "duration_ms");
    if (!duration_key || duration_key >= end) duration_key = strstr(data, "durationMs");
    if (duration_key && duration_key < end) {
        const char* duration_colon = strchr(duration_key, ':');
        if (duration_colon && duration_colon < end) {
            const char* number = duration_colon + 1;
            uint32_t parsed = 0;
            if (parse_uint(number, end, parsed)) duration_ms = parsed;
        }
    }

    bool buttons_found = false;
    if (!parse_buttons_array(data, end, state, buttons_found)) return false;
    if (!buttons_found) {
        const char* button_key = strstr(data, "\"button\"");
        if (button_key && button_key < end) {
            const char* colon = strchr(button_key, ':');
            if (!colon || colon >= end) return false;
            cursor = colon + 1;
            char button[16]{};
            if (!parse_quoted_button(cursor, end, button, sizeof(button)) ||
                !is_known_button(button)) {
                return false;
            }
            set_button(state, button);
            buttons_found = true;
        }
    }

    bool left_stick_found = false;
    bool right_stick_found = false;
    if (!parse_stick(data, end, "\"left_stick\"", state.lx, state.ly,
                     left_stick_found) ||
        !parse_stick(data, end, "\"leftStick\"", state.lx, state.ly,
                     left_stick_found) ||
        !parse_stick(data, end, "\"right_stick\"", state.rx, state.ry,
                     right_stick_found) ||
        !parse_stick(data, end, "\"rightStick\"", state.rx, state.ry,
                     right_stick_found)) {
        return false;
    }
    return buttons_found || left_stick_found || right_stick_found;
}

void udp_receive(void*, udp_pcb*, pbuf* packet, const ip_addr_t*, u16_t) {
    if (!packet) return;
    char buffer[kMaxPacket]{};
    const size_t length = std::min<size_t>(packet->tot_len, sizeof(buffer) - 1);
    pbuf_copy_partial(packet, buffer, length, 0);
    pbuf_free(packet);

    SwitchInputState parsed = neutral_input();
    uint32_t duration_ms = 100;
    if (!parse_action(buffer, length, parsed, duration_ms)) return;

    const uint32_t entered = save_and_disable_interrupts();
    g_state.input = parsed;
    g_state.expiry = make_timeout_time_ms(duration_ms);
    g_state.has_expiry = true;
    restore_interrupts(entered);
}

} // namespace

void wifi_input_backend_init() {
    g_state.input = neutral_input();
    if (cyw43_arch_init() != 0) return;
    cyw43_arch_enable_ap_mode(kApSsid, kApPassword, CYW43_AUTH_WPA2_AES_PSK);

    ip4_addr_t mask;
    ip4_addr_t gateway;
    gateway.addr = PP_HTONL(CYW43_DEFAULT_IP_AP_ADDRESS);
    mask.addr = PP_HTONL(CYW43_DEFAULT_IP_MASK);
    dhcp_server_init(&g_dhcp, &cyw43_state.netif[CYW43_ITF_AP], &gateway, &mask);

    cyw43_arch_lwip_begin();
    g_udp = udp_new();
    if (g_udp) {
        const err_t bind_result = udp_bind(g_udp, IP_ADDR_ANY, kUdpPort);
        if (bind_result == ERR_OK) {
            udp_recv(g_udp, udp_receive, nullptr);
        } else {
            udp_remove(g_udp);
            g_udp = nullptr;
        }
    }
    cyw43_arch_lwip_end();
    if (!g_udp) return;
    cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, true);
}

void wifi_input_backend_snapshot(SwitchInputState* out_state) {
    if (!out_state) return;
    const uint32_t entered = save_and_disable_interrupts();
    if (g_state.has_expiry && time_reached(g_state.expiry)) {
        g_state.input = neutral_input();
        g_state.has_expiry = false;
    }
    *out_state = g_state.input;
    restore_interrupts(entered);
}
