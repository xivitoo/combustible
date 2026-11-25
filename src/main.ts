import './index.css';
import { AppController } from './ui/AppController';

const rootEl = document.getElementById('root');
if (rootEl) {
  const app = new AppController(rootEl);
  app.mount();
}
