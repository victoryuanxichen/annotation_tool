import { createRoot } from 'react-dom/client';
import './styles';
import { App } from './App';
import { actions } from './ui/app';

const root = document.getElementById('root');
if (root) {
  // StrictMode is omitted: the player canvas belongs to the controller once attached.
  createRoot(root).render(<App />);
  void actions.init();
}
