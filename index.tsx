import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCart } from '../../lib/cart';
import { fetchProductByHandle, ProductDetail } from '../../lib/shopify';
import { C, R, S } from '../../lib/theme';

export default function ProductScreen() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [added, setAdded] = useState(false);
  const cart = useCart();

  useEffect(() => {
    if (!handle) return;
    fetchProductByHandle(handle)
      .then((p) => {
        setProduct(p);
        if (p) {
          const first = p.variants.find((v) => v.available) ?? p.variants[0];
          const init: Record<string, string> = {};
          first?.options.forEach((o) => (init[o.name] = o.value));
          setSelected(init);
        }
      })
      .finally(() => setLoading(false));
  }, [handle]);

  const variant = useMemo(() => {
    if (!product) return null;
    return (
      product.variants.find((v) => v.options.every((o) => selected[o.name] === o.value)) ?? null
    );
  }, [product, selected]);

  const optionValues = useMemo(() => {
    if (!product) return {};
    const map: Record<string, string[]> = {};
    for (const v of product.variants) {
      for (const o of v.options) {
        if (!map[o.name]) map[o.name] = [];
        if (!map[o.name].includes(o.value)) map[o.name].push(o.value);
      }
    }
    return map;
  }, [product]);

  function addToCart() {
    if (!product || !variant) return;
    cart.add({
      variantId: variant.id,
      title: product.title,
      subtitle: variant.title !== 'Default Title' ? variant.title : undefined,
      image: product.images[0] ?? null,
      price: Number(variant.price),
      currency: variant.currency,
      quantity: 1,
    });
    setAdded(true);
    setTimeout(() => setAdded(false), 1500);
  }

  if (loading) {
    return (
      <SafeAreaView style={st.safe}>
        <View style={st.center}>
          <ActivityIndicator color={C.accent} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (!product) {
    return (
      <SafeAreaView style={st.safe}>
        <View style={st.center}>
          <Text style={st.err}>המוצר לא נמצא</Text>
          <Pressable onPress={() => router.back()}>
            <Text style={st.backLink}>חזרה</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const hasRealOptions =
    product.optionNames.length > 0 && !(product.variants.length === 1 && product.variants[0].title === 'Default Title');

  return (
    <SafeAreaView style={st.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView contentContainerStyle={st.scroll}>
        <Pressable onPress={() => router.back()} style={st.backBtn} hitSlop={12}>
          <Text style={st.backText}>→ חזרה</Text>
        </Pressable>

        {product.images.length > 0 && (
          <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} style={st.gallery}>
            {product.images.map((url) => (
              <Image key={url} source={{ uri: url }} style={st.galleryImg} contentFit="cover" />
            ))}
          </ScrollView>
        )}

        <Text style={st.title}>{product.title}</Text>
        <Text style={st.price}>
          {variant ? variant.currency + variant.price : ''}
        </Text>

        {hasRealOptions &&
          product.optionNames.map((name) => (
            <View key={name}>
              <Text style={st.label}>{name}</Text>
              <View style={st.row}>
                {(optionValues[name] ?? []).map((value) => {
                  const active = selected[name] === value;
                  return (
                    <Pressable
                      key={value}
                      onPress={() => setSelected((s) => ({ ...s, [name]: value }))}
                      style={[st.optBtn, active && st.optBtnActive]}
                    >
                      <Text style={[st.optText, active && st.optTextActive]}>{value}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}

        {product.description ? <Text style={st.desc}>{product.description}</Text> : null}
      </ScrollView>

      <View style={st.footer}>
        <Pressable
          style={[st.addBtn, (!variant || !variant.available) && st.addBtnDisabled]}
          disabled={!variant || !variant.available}
          onPress={addToCart}
        >
          <Text style={st.addBtnText}>
            {added ? '✓ נוסף לעגלה' : variant && !variant.available ? 'אזל מהמלאי' : 'הוספה לעגלה'}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { paddingBottom: 110 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  err: { color: C.text, fontSize: 17, fontWeight: '700' },
  backLink: { color: C.accent, fontSize: 15, marginTop: S.sm, fontWeight: '700' },
  backBtn: { padding: S.md, alignSelf: 'flex-start' },
  backText: { color: C.accent, fontSize: 16, fontWeight: '800' },
  gallery: { height: 340 },
  galleryImg: { width: 360, height: 340 },
  title: {
    color: C.text,
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'right',
    paddingHorizontal: S.md,
    marginTop: S.md,
  },
  price: {
    color: C.accent,
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'right',
    paddingHorizontal: S.md,
    marginTop: 4,
  },
  label: {
    color: C.text,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'right',
    paddingHorizontal: S.md,
    marginTop: S.lg,
    marginBottom: S.sm,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: S.sm,
    paddingHorizontal: S.md,
    justifyContent: 'flex-end',
  },
  optBtn: {
    minWidth: 48,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: R.sm,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
  },
  optBtnActive: { borderColor: C.accent, backgroundColor: C.surfaceHi },
  optText: { color: C.textDim, fontSize: 14, fontWeight: '700' },
  optTextActive: { color: C.accent },
  desc: {
    color: C.textDim,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'right',
    paddingHorizontal: S.md,
    marginTop: S.lg,
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: S.md,
    backgroundColor: '#0d0d0dee',
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  addBtn: {
    backgroundColor: C.accent,
    borderRadius: R.full,
    paddingVertical: 15,
    alignItems: 'center',
  },
  addBtnDisabled: { backgroundColor: C.surfaceHi },
  addBtnText: { color: C.onAccent, fontSize: 17, fontWeight: '800' },
});
