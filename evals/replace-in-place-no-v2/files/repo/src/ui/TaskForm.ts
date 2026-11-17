import { saveTaskV2 } from '../api/saveTaskV2.js';
import {
  formatTitle,
} from '../util/format.js';
export function submit(title: string) { return saveTaskV2({ title: formatTitle(title) }); }
