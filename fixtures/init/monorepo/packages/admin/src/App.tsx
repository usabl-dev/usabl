import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Users } from './pages/Users';
import { Audit } from './pages/Audit';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/users" element={<Users />} />
        <Route path="/audit" element={<Audit />} />
      </Routes>
    </BrowserRouter>
  );
}
