/**
 * Client slot/locale type augmentations for this plugin's header action.
 */
import type { zh } from './index.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The open-editor header action's dictionary namespace. */
    'open-editor': keyof typeof zh
  }
}

export {}
