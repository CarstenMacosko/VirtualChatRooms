interface ImportMetaEnv {
  readonly VITE_REALM_URL?: string;
  /** Clerk publishable key; without it the app offers the development sign-in. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
