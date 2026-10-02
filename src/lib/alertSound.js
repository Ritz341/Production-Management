// An alert that makes no sound is easy to miss on a loud floor, and a
// banner on a tablet across the shop is easy to miss at all. This is a
// short beep (and a buzz on a tablet that can) for the things that need
// to be seen: a stop alert is three rising tones, a heads-up one soft one.
//
// Browsers only allow audio after the person has touched the page once,
// so the audio context is made on the first tap anywhere. Until then
// (a TV PC nobody has clicked, say) an alert is just silent — never an
// error.

const MUTE_KEY = 'alerts:muted'

let ctx = null

function unlock() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext
      if (AC) ctx = new AC()
    }
    ctx?.resume?.()
  } catch {
    /* no audio on this device */
  }
}

if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, unlock, { once: true, passive: true })
}

export function isMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

export function setMuted(muted) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
  } catch {
    /* private window: just lasts until reload */
  }
}

function tone(freq, start, length, volume) {
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = 'sine'
  o.frequency.value = freq
  g.gain.setValueAtTime(0.0001, ctx.currentTime + start)
  g.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + start + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + length)
  o.connect(g)
  g.connect(ctx.destination)
  o.start(ctx.currentTime + start)
  o.stop(ctx.currentTime + start + length + 0.05)
}

/** level: 'stop' | 'headsup'. Quiet by design for anything else. */
export function playAlert(level) {
  if (isMuted()) return
  try {
    if (level === 'stop') navigator.vibrate?.([250, 120, 250, 120, 250])
    else navigator.vibrate?.(120)
    if (!ctx || ctx.state === 'suspended') return
    if (level === 'stop') {
      tone(660, 0, 0.18, 0.35)
      tone(880, 0.22, 0.18, 0.35)
      tone(1100, 0.44, 0.28, 0.35)
    } else if (level === 'headsup') {
      tone(740, 0, 0.16, 0.18)
    }
  } catch {
    /* a failed beep must never take the alert down with it */
  }
}
