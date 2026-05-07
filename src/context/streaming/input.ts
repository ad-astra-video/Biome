import type { InputCode } from '../../types/input'
import { createStreamingContext } from './createStreamingContext'

/** Live input state (held inputs + pointer lock). */
export type InputContextValue = {
  /** Physical keyboard `InputCode`s currently held down (e.g. `'KeyW'`, `'ArrowUp'`). */
  pressedKeys: Set<InputCode>
  /** Physical mouse `InputCode`s currently held down (e.g. `'MouseLeft'`). */
  mouseButtons: Set<InputCode>
  /** Gamepad `InputCode`s currently held down (e.g. `'GamepadA'`, `'GamepadLeftStickUp'`). */
  pressedGamepad: Set<InputCode>
  scrollActive: { up: boolean; down: boolean }
  pointerLock: {
    isLocked: boolean
    /** Bumped when a pointer-lock request is denied by the browser
     *  cooldown; consumers watch this to play feedback sounds. */
    blockedSeq: number
    request: () => boolean
    exit: () => void
  }
}

export const { Context: InputContext, use: useInput } = createStreamingContext<InputContextValue>('Input')
