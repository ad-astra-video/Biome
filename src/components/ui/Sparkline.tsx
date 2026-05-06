import { useEffect, useRef } from 'react'

type SparklineProps = {
  values: number[]
  width: number
  height: number
  color: string
  maxValue?: number
}

const Sparkline = ({ values, width, height, color, maxValue }: SparklineProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || values.length < 2) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    ctx.scale(dpr, dpr)

    ctx.clearRect(0, 0, width, height)

    const max = maxValue ?? Math.max(...values)
    if (max <= 0) return

    const stepX = width / (values.length - 1)
    const padding = 1

    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.lineJoin = 'round'

    for (let i = 0; i < values.length; i++) {
      const x = i * stepX
      const y = height - padding - (values[i] / max) * (height - padding * 2)
      if (i === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }

    ctx.stroke()
  }, [values, width, height, color, maxValue])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: `${width}px`, height: `${height}px` }}
      className="inline-block align-middle opacity-70"
    />
  )
}

export default Sparkline
