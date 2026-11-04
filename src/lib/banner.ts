// Обрезка баннера профиля. Файл перекодируется на компьютере пользователя: на сервер уходит
// только обрезанное изображение нужного размера, метаданные исходного файла (например, EXIF) в него не попадают.
import { MAX_IMAGE } from './media';

export const BANNER_ASPECT = 5 / 2;
export const BANNER_MIME = ['image/png', 'image/jpeg', 'image/webp'];
export const BANNER_MAX_ZOOM = 3;
const OUTPUT_WIDTH = 1500;

/** Видимая область изображения в его пикселях; cx, cy — её центр */
export interface BannerCrop {
  cx: number;
  cy: number;
  zoom: number;
}

export function bannerFileError(file: File): string | null {
  if (!BANNER_MIME.includes(file.type)) return 'Поддерживаются PNG, JPG, JPEG и WebP';
  if (file.size > MAX_IMAGE) return 'Размер файла должен быть не больше 5 МБ';
  return null;
}

export function cropSize(width: number, height: number, zoom: number): { w: number; h: number } {
  const w = Math.min(width, height * BANNER_ASPECT) / zoom;
  return { w, h: w / BANNER_ASPECT };
}

/** Удерживает видимую область внутри изображения: пустых полей в баннере не бывает */
export function clampCrop(width: number, height: number, crop: BannerCrop): BannerCrop {
  const zoom = Math.min(BANNER_MAX_ZOOM, Math.max(1, crop.zoom));
  const { w, h } = cropSize(width, height, zoom);
  return {
    zoom,
    cx: Math.min(width - w / 2, Math.max(w / 2, crop.cx)),
    cy: Math.min(height - h / 2, Math.max(h / 2, crop.cy)),
  };
}

export function renderBanner(image: HTMLImageElement, crop: BannerCrop): Promise<File> {
  const { w, h } = cropSize(image.naturalWidth, image.naturalHeight, crop.zoom);
  const canvas = document.createElement('canvas');
  // Маленькое изображение не растягивается: качество всё равно не прибавится, а файл вырастет
  canvas.width = Math.max(1, Math.round(Math.min(OUTPUT_WIDTH, w)));
  canvas.height = Math.max(1, Math.round(canvas.width / BANNER_ASPECT));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Не удалось обработать изображение'));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, crop.cx - w / 2, crop.cy - h / 2, w, h, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error('Не удалось обработать изображение'));
        else if (blob.size > MAX_IMAGE) reject(new Error('Обработанное изображение больше 5 МБ'));
        else resolve(new File([blob], 'banner.webp', { type: 'image/webp' }));
      },
      'image/webp',
      0.9,
    );
  });
}
