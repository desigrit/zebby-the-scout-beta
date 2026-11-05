import path from "node:path";
import packageInfo from "../package.json";
import { configureApplicationProfile } from "./app-identity";

export const BETA_APP_NAME = packageInfo.build.productName;
// Keep earlier beta settings and model downloads when the display name changes.
const PROFILE_FOLDER = "Zebby Core";

export function configureBetaProfile(app: Parameters<typeof configureApplicationProfile>[0], isolatedFolder?: string) {
  const profile = configureApplicationProfile(app, isolatedFolder || path.join(app.getPath("appData"), PROFILE_FOLDER));
  app.setName(BETA_APP_NAME);
  return profile;
}
