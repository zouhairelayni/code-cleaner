import {
  cx,
} from './internal/helpers';
import type {
  Theme,
} from './theme';
export const Card = (t?: Theme) => cx('card', t?.name);
