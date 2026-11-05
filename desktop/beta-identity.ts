import path from "node:path";
import { configureApplicationProfile } from "./app-identity";

export const CORE_APP_NAME = "Zebby Core";
export function configureCoreProfile(app: Parameters<typeof configureApplicationProfile>[0], isolatedFolder?: string) {
  const profile = configureApplicationProfile(app, isolatedFolder || path.join(app.getPath("appData"), CORE_APP_NAME));
  app.setName(CORE_APP_NAME);
  return profile;
}
