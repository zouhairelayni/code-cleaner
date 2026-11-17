import { flag } from './new-feature-flag';
const Extras = React.lazy(() => import('./HeroExtras'));
export const Hero = () => [Extras, flag];
