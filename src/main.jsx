import React from 'react';
import {createRoot} from 'react-dom/client';
import Auth from './components/Auth.jsx';
import './styles.css';
import '@fontsource-variable/noto-sans-sc';
import '@fontsource-variable/source-serif-4';
createRoot(document.getElementById('root')).render(<Auth/>);
