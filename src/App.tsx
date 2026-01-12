import { Navigate, Route, Routes } from 'react-router-dom'
import { Account } from './pages/Account'
import { Camera } from './pages/Camera'
import { Landing } from './pages/Landing'

export function App() {
  return (
    <Routes>
      <Route path="/lp" element={<Landing />} />
      <Route path="/" element={<Camera />} />
      <Route path="/account" element={<Account />} />
      <Route path="/chat" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
