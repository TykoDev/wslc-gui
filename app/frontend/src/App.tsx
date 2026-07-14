import { Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout.tsx";
import { ContainersPage } from "./pages/Containers.tsx";
import { ImagesPage } from "./pages/Images.tsx";
import { ResourcesPage } from "./pages/Resources.tsx";
import { DeployPage } from "./pages/Deploy.tsx";
import { SettingsPage } from "./pages/Settings.tsx";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/containers" element={<ContainersPage />} />
        <Route path="/images" element={<ImagesPage />} />
        <Route path="/resources" element={<ResourcesPage />} />
        <Route path="/deploy" element={<DeployPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/containers" replace />} />
      </Route>
    </Routes>
  );
}
