// The app's building blocks. Two looks, one set of parts:
//   tone="paper"  office / admin screens (light)
//   tone="floor"  tablets and TVs (dark, read across a bright shop)
// Every screen used to style its own cards and chips inline, so they
// drifted apart; new screens should reach for these instead.
//
// Sizes are set for the floor phones (Samsung A11, 360px wide): tap
// targets at least 44px, text no smaller than 12px.

import { useEffect } from 'react'

const cx = (...parts) => parts.filter(Boolean).join(' ')

/** A panel. tone: paper | floor. */
export function Card({ tone = 'paper', className, children, ...rest }) {
  return (
    <section
      className={cx(
        'rounded-2xl border',
        tone === 'floor' ? 'bg-floorCard border-floorLine text-paper' : 'bg-white border-paperDim text-charcoal',
        className
      )}
      {...rest}
    >
      {children}
    </section>
  )
}

/** A card's heading row: title, optional line under it, optional action on the right. */
export function SectionHeader({ title, sub, action, tone = 'paper', className }) {
  return (
    <div className={cx('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className={cx('font-display font-bold text-xl uppercase tracking-wide leading-tight', tone === 'floor' ? 'text-paper' : 'text-charcoal')}>
          {title}
        </h2>
        {sub && <p className={cx('text-sm mt-0.5', tone === 'floor' ? 'text-floorMute' : 'text-steelLight')}>{sub}</p>}
      </div>
      {action}
    </div>
  )
}

const CHIP = {
  paper: {
    neutral: 'bg-paperDim text-steel border-paperDim',
    good: 'bg-andonGreenBg text-andonGreen border-andonGreenBg',
    warn: 'bg-safety/15 text-safetyDark border-safety',
    bad: 'bg-andonRedBg text-andonRed border-andonRedBg',
    info: 'bg-andonBlueBg text-andonBlue border-andonBlueBg',
    solid: 'bg-charcoal text-paper border-charcoal',
  },
  floor: {
    neutral: 'bg-floorLine text-paper border-floorLine',
    good: 'bg-[#16301F] text-[#7FD49A] border-[#4CC46F]',
    warn: 'bg-safety text-charcoal border-safety',
    bad: 'bg-andonRed text-white border-andonRed',
    info: 'bg-[#5B9BD5] text-charcoal border-[#5B9BD5]',
    outline: 'bg-transparent text-safety border-safety',
    solid: 'bg-paper text-charcoal border-paper',
  },
}

/** A small label. kind: neutral | good | warn | bad | info | outline | solid. */
export function Chip({ kind = 'neutral', tone = 'paper', className, children, ...rest }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-bold leading-tight whitespace-nowrap',
        CHIP[tone][kind] ?? CHIP[tone].neutral,
        className
      )}
      {...rest}
    >
      {children}
    </span>
  )
}

const BUTTON = {
  primary: 'bg-safety text-charcoal hover:brightness-95',
  go: 'bg-[#4CC46F] text-charcoal hover:brightness-95',
  dark: 'bg-charcoal text-paper hover:bg-steel',
  ghost: 'bg-transparent text-steel border border-paperDim hover:bg-paperDim',
  ghostFloor: 'bg-transparent text-floorMute border border-floorLine hover:text-paper',
  danger: 'bg-andonRed text-white hover:brightness-110',
  link: 'bg-transparent text-andonBlue hover:underline px-0',
}

/** kind: primary | go | dark | ghost | ghostFloor | danger | link. size: sm | md | lg. */
export function Button({ kind = 'primary', size = 'md', block, className, children, ...rest }) {
  return (
    <button
      className={cx(
        'rounded-xl font-semibold transition active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100',
        size === 'sm' ? 'text-sm px-3 py-2 min-h-[36px]' : size === 'lg' ? 'text-lg px-5 py-3.5 min-h-[56px] font-bold' : 'text-sm px-4 py-2.5 min-h-[44px]',
        block && 'w-full',
        BUTTON[kind],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/** A number with a label: "31% · week complete". */
export function Stat({ label, value, sub, tone = 'paper', valueClass, className }) {
  return (
    <div className={className}>
      <div className={cx('text-[11px] uppercase tracking-[0.14em] font-semibold', tone === 'floor' ? 'text-floorMute' : 'text-steelLight')}>{label}</div>
      <div className={cx('font-display font-extrabold text-3xl leading-none mt-1 tabular-nums', valueClass)}>{value}</div>
      {sub && <div className={cx('text-xs mt-1', tone === 'floor' ? 'text-floorMute' : 'text-steelLight')}>{sub}</div>}
    </div>
  )
}

/** A thin progress bar. pct 0–100; mark = optional target position. */
export function Progress({ pct, mark, tone = 'paper', barClass = 'bg-andonGreen', className }) {
  return (
    <div className={cx('relative h-2 rounded-full overflow-hidden', tone === 'floor' ? 'bg-floorLine' : 'bg-paperDim', className)}>
      <i className={cx('block h-full transition-[width] duration-500', barClass)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      {mark != null && <span className="absolute top-0 bottom-0 w-[3px] bg-safety" style={{ left: `${Math.min(100, mark)}%` }} />}
    </div>
  )
}

/**
 * A panel that slides in over the page: from the right on a wide screen,
 * full screen on a phone. Escape or the backdrop closes it.
 */
export function Sheet({ open, onClose, title, sub, tone = 'paper', children, footer, wide }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])
  if (!open) return null
  const floor = tone === 'floor'
  return (
    <div className="fixed inset-0 z-[200] flex justify-end" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
      <div className="absolute inset-0 bg-charcoal/60" onClick={onClose} />
      <div
        className={cx(
          'relative h-full w-full flex flex-col shadow-2xl animate-[sheetIn_.18s_ease-out]',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
          floor ? 'bg-floor text-paper' : 'bg-paper text-charcoal'
        )}
      >
        <header className={cx('flex items-start justify-between gap-3 px-4 py-3 border-b-4 border-safety', floor ? 'bg-floorCard' : 'bg-charcoal')}>
          <div className="min-w-0">
            <div className="font-display font-bold text-2xl text-paper leading-tight break-words">{title}</div>
            {sub && <div className="text-sm text-floorMute mt-0.5">{sub}</div>}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg text-paper/80 hover:text-paper text-2xl leading-none w-11 h-11 -mr-2" aria-label="Close">
            ×
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <div className={cx('border-t px-4 py-3', floor ? 'border-floorLine bg-floorCard' : 'border-paperDim bg-white')}>{footer}</div>}
      </div>
    </div>
  )
}
