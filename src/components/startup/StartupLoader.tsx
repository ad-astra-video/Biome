import { useTranslation } from 'react-i18next'

/** Splash overlay shown during the local-server boot pipeline.
 *
 *  "Starting World Engine…" sits in the bottom-right, baseline-aligned
 *  with where the Biome wordmark will sit at bottom-left once the menu
 *  mounts. The two never share the screen — this caption unmounts the
 *  same render the menu's ViewLabel mounts — but the matching baseline
 *  keeps the bottom edge of the screen feeling intentional across the
 *  handoff. The portal's spawn-in animation takes the centre. */
const StartupLoader = () => {
  const { t } = useTranslation()
  return (
    <div className="pointer-events-auto absolute inset-0 z-30" role="status" aria-live="polite">
      <p
        className="
          absolute right-(--edge-right) bottom-(--edge-bottom) m-0 font-serif text-[4cqh] leading-[0.8] font-normal
          text-text-primary [text-shadow:0_0.14cqh_0.83cqh_rgba(0,0,0,0.5)]
        "
      >
        {t('app.startup.startingEngine')}
      </p>
    </div>
  )
}

export default StartupLoader
