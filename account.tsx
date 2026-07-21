import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { I18nManager, Platform } from 'react-native';
import { CartProvider } from '../lib/cart';
import { C } from '../lib/theme';

// עברית RTL בכל האפליקציה
if (Platform.OS === 'web') {
  if (typeof document !== 'undefined') document.documentElement.dir = 'rtl';
} else if (!I18nManager.isRTL) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
}

export default function RootLayout() {
  return (
    <CartProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: C.bg },
        }}
      />
    </CartProvider>
  );
}
