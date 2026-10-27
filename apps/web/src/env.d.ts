interface ImportMetaEnv {
  readonly VITE_REALM_URL?: string;
  /** Clerk publishable key; without it the app offers the development sign-in. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  /** This build's id (vite.config.ts), compared with /version.json to notice a newer deploy. */
  readonly VITE_BUILD_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
