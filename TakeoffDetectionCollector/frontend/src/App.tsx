import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { isAuthenticated } from "./lib/api";
import AuthCallbackPage from "./pages/AuthCallbackPage";
import CleanPage from "./pages/CleanPage";
import InboxPage from "./pages/InboxPage";
import LoginPage from "./pages/LoginPage";

function RequireAuth({ children }: { children: ReactNode }) {
  if (!isAuthenticated()) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <InboxPage />
          </RequireAuth>
        }
      />
      <Route
        path="/jobs/:id"
        element={
          <RequireAuth>
            <CleanPage />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
