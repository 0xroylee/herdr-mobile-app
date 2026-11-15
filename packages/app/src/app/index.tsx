import { type Href, Redirect } from "expo-router";
import { useStore } from "zustand";
import { routes } from "../routes.ts";
import { HomeScreen } from "../screens/home/HomeScreen.tsx";
import { shouldRedirectToPair } from "../screens/pair/pair-fragment.ts";
import { machinesStore } from "../store/platform.ts";

export default function HomeRoute() {
  const hasMachine = useStore(machinesStore, (state) => Object.keys(state.machines).length > 0);
  if (shouldRedirectToPair(hasMachine)) return <Redirect href={routes.pair as Href} />;
  return <HomeScreen />;
}
