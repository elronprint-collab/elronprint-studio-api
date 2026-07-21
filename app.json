import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;
const CLOUD = extra.CLOUDINARY_CLOUD || 'dztd5g0p8';
const PRESET = extra.CLOUDINARY_PRESET || 'elronprint';

export async function uploadImage(localUri: string): Promise<string> {
  const form = new FormData();
  // @ts-expect-error React Native FormData file object
  form.append('file', { uri: localUri, name: 'design.jpg', type: 'image/jpeg' });
  form.append('upload_preset', PRESET);
  form.append('folder', 'elronprint-orders');

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error('ההעלאה נכשלה, נסו שוב');
  const json = await res.json();
  return json.secure_url as string;
}
