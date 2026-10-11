/** Defaults tuned for Discord 20ms Opus frames. */
export const SPEAKING_DEFAULTS = {
  /** Must stay in speaking + activity this long before "started speaking". */
  confirmMs: 1000,
  /** Must stay silent this long before "stopped speaking". */
  silenceMs: 1000,
  /** Opus packets smaller than this count as noise/comfort, not activity. */
  minPacketBytes: 40,
  /** Active packets required inside the confirm window (~20 × 20ms ≈ 400ms of real speech). */
  minActivePackets: 20,
};

/**
 * Debounced speaking detector with a packet-size activity floor.
 * Discord speaking flags alone flicker; this waits for sustained input.
 */
export class SpeakingGate {
  /**
   * @param {{
   *   confirmMs?: number,
   *   silenceMs?: number,
   *   minPacketBytes?: number,
   *   minActivePackets?: number,
   *   onStarted?: (userId: string, displayName: string) => void,
   *   onStopped?: (userId: string, displayName: string) => void,
   *   onConfirmed?: (userId: string) => void,
   *   setTimeout?: typeof setTimeout,
   *   clearTimeout?: typeof clearTimeout,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.confirmMs = opts.confirmMs ?? SPEAKING_DEFAULTS.confirmMs;
    this.silenceMs = opts.silenceMs ?? SPEAKING_DEFAULTS.silenceMs;
    this.minPacketBytes = opts.minPacketBytes ?? SPEAKING_DEFAULTS.minPacketBytes;
    this.minActivePackets = opts.minActivePackets ?? SPEAKING_DEFAULTS.minActivePackets;
    this.onStarted = opts.onStarted ?? (() => {});
    this.onStopped = opts.onStopped ?? (() => {});
    this.onConfirmed = opts.onConfirmed ?? (() => {});
    this.setTimeout = opts.setTimeout ?? setTimeout;
    this.clearTimeout = opts.clearTimeout ?? clearTimeout;
    /** @type {Map<string, {
     *   displayName: string,
     *   flagSpeaking: boolean,
     *   confirmed: boolean,
     *   activePackets: number,
     *   startTimer: ReturnType<typeof setTimeout> | null,
     *   stopTimer: ReturnType<typeof setTimeout> | null,
     * }>} */
    this.users = new Map();
  }

  #state(userId, displayName) {
    let s = this.users.get(userId);
    if (!s) {
      s = {
        displayName: displayName ?? userId,
        flagSpeaking: false,
        confirmed: false,
        activePackets: 0,
        startTimer: null,
        stopTimer: null,
      };
      this.users.set(userId, s);
    } else if (displayName) {
      s.displayName = displayName;
    }
    return s;
  }

  #clearTimer(s, key) {
    if (s[key] != null) {
      this.clearTimeout(s[key]);
      s[key] = null;
    }
  }

  /**
   * @param {string} userId
   * @param {string} displayName
   */
  speakingStart(userId, displayName) {
    const s = this.#state(userId, displayName);
    s.flagSpeaking = true;
    this.#clearTimer(s, 'stopTimer');

    if (s.confirmed) return;

    if (s.startTimer == null) {
      s.activePackets = 0;
      s.startTimer = this.setTimeout(() => {
        s.startTimer = null;
        if (!s.flagSpeaking) return;
        if (s.activePackets < this.minActivePackets) return;
        if (s.confirmed) return;
        s.confirmed = true;
        this.onConfirmed(userId);
        this.onStarted(userId, s.displayName);
      }, this.confirmMs);
    }
  }

  /** @param {string} userId */
  speakingEnd(userId) {
    const s = this.users.get(userId);
    if (!s) return;
    s.flagSpeaking = false;
    this.#clearTimer(s, 'startTimer');

    if (!s.confirmed) {
      s.activePackets = 0;
      return;
    }

    if (s.stopTimer == null) {
      s.stopTimer = this.setTimeout(() => {
        s.stopTimer = null;
        if (s.flagSpeaking) return;
        this.onStopped(userId, s.displayName);
        // Allow a later sustained talk spurt to log "started" again
        s.confirmed = false;
        s.activePackets = 0;
      }, this.silenceMs);
    }
  }

  /**
   * Feed decrypted Opus packets for the activity floor.
   * @param {string} userId
   * @param {Buffer | Uint8Array} packet
   */
  onPacket(userId, packet) {
    const s = this.users.get(userId);
    if (!s || !s.flagSpeaking || s.confirmed) return;
    if (!packet || packet.length < this.minPacketBytes) return;
    s.activePackets += 1;
  }

  /**
   * Cancel timers (user left / segment finalized). Logs stop if mid-confirmed speech.
   * @param {string} userId
   */
  clear(userId) {
    const s = this.users.get(userId);
    if (!s) return;
    this.#clearTimer(s, 'startTimer');
    this.#clearTimer(s, 'stopTimer');
    if (s.confirmed) {
      this.onStopped(userId, s.displayName);
    }
    this.users.delete(userId);
  }

  /** Tear down all users. */
  clearAll() {
    for (const userId of [...this.users.keys()]) {
      this.clear(userId);
    }
  }
}
