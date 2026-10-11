import { SetMetadata } from "@nestjs/common";

const APP_ACCESS_PUBLIC = "nova:app-access-public";

/** Public only to allow health probes and the access bootstrap endpoints through the app gate. */
export const AppAccessPublic = () => SetMetadata(APP_ACCESS_PUBLIC, true);
export { APP_ACCESS_PUBLIC };
