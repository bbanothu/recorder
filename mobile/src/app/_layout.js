import { useColorScheme } from 'react-native';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { RecorderProvider } from '../native/RecorderContext.js';

/**
 * expo-router's Stack (the native header bar) doesn't follow the system
 * light/dark setting on its own — it always defaults to its light theme
 * (expo-router/build/fork/NavigationContainer.js) — so it's set explicitly
 * here. Screen content themes itself via native/ui.js's useTheme().
 */
export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <RecorderProvider>
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <StatusBar style="auto" />
        <Stack>
          <Stack.Screen name="index" options={{ title: 'Phone Recorder' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
          <Stack.Screen name="clips/index" options={{ title: 'Clips' }} />
          <Stack.Screen name="clips/[id]" options={{ title: 'Transcript' }} />
        </Stack>
      </ThemeProvider>
    </RecorderProvider>
  );
}
