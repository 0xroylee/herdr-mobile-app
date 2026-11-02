import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { useCSSVariable } from "uniwind";

export interface SpinnerProps {
  size?: number;
}

export function Spinner({ size = 24 }: SpinnerProps) {
  const reduceMotion = useReducedMotion();
  const rotation = useSharedValue(0);
  const workingColor = useCSSVariable("--color-working");
  const trackColor = useCSSVariable("--color-spinner-track");

  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(rotation);
      rotation.value = 0;
      return;
    }

    rotation.value = withRepeat(
      withTiming(360, { duration: 900, easing: Easing.linear }),
      -1,
      false,
    );

    return () => cancelAnimation(rotation);
  }, [reduceMotion, rotation]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View style={[{ height: size, width: size }, animatedStyle]}>
      <Svg height={size} viewBox="0 0 24 24" width={size}>
        <Circle
          cx="12"
          cy="12"
          fill="none"
          r="8.4"
          stroke={typeof trackColor === "string" ? trackColor : undefined}
          strokeWidth={3.2}
        />
        <Path
          d="M 12 3.6 A 8.4 8.4 0 0 1 20.4 12"
          fill="none"
          stroke={typeof workingColor === "string" ? workingColor : undefined}
          strokeLinecap="round"
          strokeWidth={3.2}
        />
      </Svg>
    </Animated.View>
  );
}
