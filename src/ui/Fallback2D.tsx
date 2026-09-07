import { ArrowUpRight } from '@phosphor-icons/react'
import { HOTSPOTS, PROFILE, PROJECTS } from '../content'

/**
 * Rendered instead of the canvas when WebGL is unavailable or when the device is
 * too small for the hotspots to be hittable. Same content source as the 3D
 * route, so nothing is hidden behind the requirement to run a GPU.
 */
export function Fallback2D({ reason }: { reason: 'nogl' | 'small' }) {
  return (
    <main className="mx-auto min-h-[100dvh] max-w-[46rem] px-6 py-16 sm:px-8">
      <p className="font-mono text-sm tracking-tight text-bright">{PROFILE.handle}</p>

      <h1 className="mt-10 text-4xl font-medium leading-[1.05] tracking-tight text-bright sm:text-5xl">
        {PROFILE.role},
        <br />
        and the room it happens in.
      </h1>
      <p className="mt-4 max-w-[42ch] text-body">{PROFILE.intro}</p>

      <section className="mt-14">
        <h2 className="text-2xl tracking-tight text-bright">Work</h2>
        <div className="mt-6 grid gap-px overflow-hidden rounded-[14px] bg-hair">
          {PROJECTS.map((p) => (
            <article key={p.name} className="bg-ink p-6">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h3 className="text-xl tracking-tight text-bright">{p.name}</h3>
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-acid">
                  {p.status === 'live' ? 'Live' : 'In design'}
                </span>
              </div>
              <p className="mt-1 text-body">{p.tagline}</p>
              <p className="mt-3 text-sm leading-relaxed text-mute">{p.body}</p>
              <a
                href={p.href}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-acid px-4 py-2 text-sm font-medium text-void"
              >
                Open {p.name}
                <ArrowUpRight size={15} weight="bold" />
              </a>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl tracking-tight text-bright">Elsewhere</h2>
        <ul className="mt-5 space-y-2 text-body">
          <li>
            <a
              className="underline decoration-hair underline-offset-4 hover:text-bright"
              href={PROFILE.github}
              target="_blank"
              rel="noreferrer noopener"
            >
              github.com/kr4t0n
            </a>
          </li>
        </ul>
        <p className="mt-6 text-sm text-mute">
          Still to come: {HOTSPOTS.filter((h) => h.placeholder).map((h) => h.label.toLowerCase()).join(', ')}.
        </p>
      </section>

      <p className="mt-16 text-sm text-mute">
        {reason === 'nogl'
          ? 'There is a 3D version of this page, but your browser does not report WebGL support.'
          : 'There is a 3D version of this page, best on a larger screen with a pointer.'}
      </p>
    </main>
  )
}
