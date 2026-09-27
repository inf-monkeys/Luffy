export const GAME_PROFILE_SCHEMA_VERSION = 1;

// These are the controls the Pico Switch Pro Controller adapter can encode.
// Every game profile must describe every one of them, even when a game does
// not use a particular control. That keeps the model's action vocabulary
// stable across games.
export const STANDARD_CONTROL_IDS = [
  "A", "B", "X", "Y", "L", "R", "ZL", "ZR",
  "UP", "DOWN", "LEFT", "RIGHT", "L3", "R3", "PLUS", "MINUS",
  "HOME", "CAPTURE", "LEFT_STICK", "RIGHT_STICK", "WAIT",
];

export const STANDARD_BUTTON_IDS = [
  "A", "B", "X", "Y", "L", "R", "ZL", "ZR",
  "UP", "DOWN", "LEFT", "RIGHT", "L3", "R3", "PLUS", "MINUS",
  "HOME", "CAPTURE", "WAIT",
];

const CONTROL_TYPES = new Set(["button", "stick", "system", "neutral"]);

function fail(message) {
  throw Object.assign(new Error(`Invalid game profile: ${message}`), { statusCode: 400 });
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) fail(`${name} must be a non-empty string`);
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
}

function validateControl(control, id) {
  requireObject(control, `controls.${id}`);
  if (!CONTROL_TYPES.has(control.type)) fail(`controls.${id}.type must be button, stick, system, or neutral`);
  requireString(control.meaning, `controls.${id}.meaning`);
  requireString(control.how_to_press, `controls.${id}.how_to_press`);
  requireString(control.when_to_use, `controls.${id}.when_to_use`);
  if (control.notes !== undefined) requireString(control.notes, `controls.${id}.notes`);
}

function validateStick(value, name) {
  if (value === undefined) return;
  requireObject(value, name);
  for (const axis of ["x", "y"]) {
    if (!Number.isFinite(Number(value[axis])) || Number(value[axis]) < -1 || Number(value[axis]) > 1) {
      fail(`${name}.${axis} must be a number between -1 and 1`);
    }
  }
}

function validateCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 12) {
    fail("candidates must contain 2 to 12 actions");
  }
  const ids = new Set();
  for (const candidate of candidates) {
    requireObject(candidate, "candidate");
    requireString(candidate.id, "candidate.id");
    requireString(candidate.description, `candidates.${candidate.id}.description`);
    if (ids.has(candidate.id)) fail(`candidate id is duplicated: ${candidate.id}`);
    ids.add(candidate.id);
    if (!Array.isArray(candidate.buttons) || candidate.buttons.length === 0) {
      fail(`candidates.${candidate.id}.buttons must be a non-empty array`);
    }
    for (const button of candidate.buttons) {
      if (typeof button !== "string" || !STANDARD_BUTTON_IDS.includes(button)) {
        fail(`candidates.${candidate.id}.buttons contains unsupported control ${button}`);
      }
    }
    validateStick(candidate.left_stick, `candidates.${candidate.id}.left_stick`);
    validateStick(candidate.right_stick, `candidates.${candidate.id}.right_stick`);
    if (candidate.duration_ms !== undefined && (!Number.isInteger(candidate.duration_ms) || candidate.duration_ms < 0 || candidate.duration_ms > 10000)) {
      fail(`candidates.${candidate.id}.duration_ms must be an integer between 0 and 10000`);
    }
    if (candidate.intent !== undefined) requireString(candidate.intent, `candidates.${candidate.id}.intent`);
    if (candidate.when_to_use !== undefined) requireString(candidate.when_to_use, `candidates.${candidate.id}.when_to_use`);
  }
}

function validateObservations(observations) {
  if (observations === undefined) return;
  requireObject(observations, "observations");
  for (const [id, observation] of Object.entries(observations)) {
    requireObject(observation, `observations.${id}`);
    requireString(observation.meaning, `observations.${id}.meaning`);
    requireString(observation.how_to_read, `observations.${id}.how_to_read`);
    requireString(observation.when_relevant, `observations.${id}.when_relevant`);
  }
}

export function validateGameProfile(profile, { source = "profile" } = {}) {
  requireObject(profile, source);
  if (profile.schema_version !== GAME_PROFILE_SCHEMA_VERSION) {
    fail(`${source}.schema_version must be ${GAME_PROFILE_SCHEMA_VERSION}`);
  }
  for (const field of ["id", "game", "introduction", "objective", "state_notes"]) requireString(profile[field], `${source}.${field}`);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(profile.id)) fail(`${source}.id must contain only letters, numbers, _ or -`);

  requireObject(profile.controller, `${source}.controller`);
  for (const field of ["platform", "layout", "button_encoding"]) requireString(profile.controller[field], `${source}.controller.${field}`);
  if (profile.controller.supports_simultaneous !== true) fail(`${source}.controller.supports_simultaneous must be true`);
  if (profile.controller.supports_sticks !== true) fail(`${source}.controller.supports_sticks must be true`);
  if (profile.controller.supports_motion !== false) fail(`${source}.controller.supports_motion must be false for this Pico hardware`);
  if (!Array.isArray(profile.controller.unsupported_sensors) || !profile.controller.unsupported_sensors.every((item) => typeof item === "string" && item.trim())) {
    fail(`${source}.controller.unsupported_sensors must be an array of strings`);
  }

  requireObject(profile.gameplay, `${source}.gameplay`);
  for (const field of ["mode", "completion_signal"]) requireString(profile.gameplay[field], `${source}.gameplay.${field}`);
  for (const field of ["active_states", "non_active_states"]) {
    if (!Array.isArray(profile.gameplay[field]) || profile.gameplay[field].length === 0 || !profile.gameplay[field].every((item) => typeof item === "string" && item.trim())) {
      fail(`${source}.gameplay.${field} must be a non-empty array of strings`);
    }
  }

  requireObject(profile.controls, `${source}.controls`);
  for (const id of STANDARD_CONTROL_IDS) validateControl(profile.controls[id], id);
  validateObservations(profile.observations);

  requireObject(profile.capture, `${source}.capture`);
  requireString(profile.capture.size, `${source}.capture.size`);
  if (!Number.isFinite(Number(profile.capture.framerate)) || Number(profile.capture.framerate) <= 0) fail(`${source}.capture.framerate must be positive`);
  if (profile.capture.device !== undefined) requireString(profile.capture.device, `${source}.capture.device`);

  requireObject(profile.runtime, `${source}.runtime`);
  for (const field of ["decision_interval_ms", "action_duration_ms"]) {
    if (!Number.isFinite(Number(profile.runtime[field])) || Number(profile.runtime[field]) <= 0) fail(`${source}.runtime.${field} must be positive`);
  }
  if (profile.runtime.movement_switch_confirmations !== undefined
      && (!Number.isInteger(profile.runtime.movement_switch_confirmations)
        || profile.runtime.movement_switch_confirmations < 1
        || profile.runtime.movement_switch_confirmations > 5)) {
    fail(`${source}.runtime.movement_switch_confirmations must be an integer between 1 and 5`);
  }
  if (!Number.isFinite(Number(profile.runtime.min_action_confidence)) || Number(profile.runtime.min_action_confidence) < 0 || Number(profile.runtime.min_action_confidence) > 1) {
    fail(`${source}.runtime.min_action_confidence must be between 0 and 1`);
  }
  validateCandidates(profile.candidates);
  return profile;
}

export function isProfileFile(name) {
  return name.endsWith(".json") && !name.endsWith(".schema.json");
}
