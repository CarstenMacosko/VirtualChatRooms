import { useAppUpdate } from "../lib/appUpdate";

/** Offers a reload once a newer version of the app has been deployed. */
export function UpdateBanner() {
  const ready = useAppUpdate();
  if (!ready) return null;
  return (
    <div className="update-banner" role="status">
      <span>A new version of the app is ready.</span>
      <button className="primary small" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
