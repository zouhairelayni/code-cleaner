import styles from './button.module.css';
import { cx } from './internal/helpers';
import { money } from '@acme/core/money';
export const Button = () => cx(styles.btn, money(1));
