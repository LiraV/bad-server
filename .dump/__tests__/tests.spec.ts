import fs from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';
import shell from 'shelljs';

const wait = (ms: number) => new Promise(res => setTimeout(res, ms));

const requestWithRetry = async (
  request: any,
  method: 'get' | 'post',
  url: string,
  options: Record<string, any> = {},
  retries = 3,
) => {
  let attempt = 0;
  let response;
  while (attempt <= retries) {
    response = await request[method](url, options);
    if (response.status() !== 429) {
      return response;
    }
    await wait(6000);
    attempt += 1;
  }
  return response;
};

test.describe('Проверка на уязвимость пакетов', () => {
  test('Аудит backend пакетов', () => {
    const result = shell.exec('npm audit', { cwd: `${process.env.GITHUB_WORKSPACE}/backend`, silent: true });
    expect(result.code).toEqual(0);
  });
});

test.describe('Проверка заказов', () => {
  test.afterEach(async () => {
    await new Promise(res => setTimeout(res, 3000));
  });

  test('Нормализован лимит', async ({ request }) => {
    const response = await requestWithRetry(request, 'get', `${process.env.API_URL}/order/all?page=2&limit=1000`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      }
    });
    const data = await response.json();
    expect(response.ok()).toBeTruthy();
    expect(data.pagination.pageSize).toBeLessThanOrEqual(10);
  });

  test('При избыточной аггрегации, уязвимой к инъекции должна быть ошибка', async ({ request }) => {
    const response = await requestWithRetry(request, 'get', `${process.env.API_URL}/order/all?status[$expr][$function][body]='function%20(status)%20%7B%20return%20status%20%3D%3D%3D%20%22completed%22%20%7D'&status[$expr][$function][lang]=js&status[$expr][$function][args][0]=%24status`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      }
    });
    expect(response.ok()).toBeFalsy();
  });

  test('Санитизирован комментарий', async ({ request }) => {
    const response = await requestWithRetry(request, 'post', `${process.env.API_URL}/order`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      },
      data: {
        "payment": "online",
        "email": "test@test.ru",
        "phone": "+71234567890",
        "address": "Spb Vosstania 1",
        "total": 1450,
        "items": [
          "66601a8657ecac94459696d4"
        ],
        "comment": "Catch you <img src=\"https://placehold.co/1\" onload=\"javascript:(function () {window.alert('hello!')})();\">"
      }
    });
    const data = await response.json();
    expect(data.comment).not.toEqual("Catch you <img src=\"https://placehold.co/1\" onload=\"javascript:(function () {window.alert('hello!')})();\">");
  });

  test('Уязвимость телефона', async ({ request }) => {
    const response = await requestWithRetry(request, 'post', `${process.env.API_URL}/order`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      },
      data: {
        "address": "Васильевская 86",
        "payment": "online",
        "phone": "111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111a",
        "total": 2200,
        "email": "maxim_91@inbox.ru",
        "items": ["66601a7857ecac94459696d0", "66601a8657ecac94459696d4"]
      }
    });

    expect(response.status()).toEqual(400);
  });

  test('Проверка роли (у пользователя отсутствует доступ к базе всех заказов)', async ({ request }) => {
    const response = await requestWithRetry(request, 'get', `${process.env.API_URL}/order/all`, {
      headers: {
        'Authorization': `Bearer ${process.env.USER_TOKEN}`
      }
    });

    expect(response.ok()).toBeFalsy();
    expect(response.status()).toEqual(403);
  });
});

test.describe('Проверка пользователей', () => {
  test.afterEach(async () => {
    await new Promise(res => setTimeout(res, 3000));
  });

  test('Нормализован лимит', async ({ request }) => {
    const response = await requestWithRetry(request, 'get', `${process.env.API_URL}/customers?limit=1000`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      }
    });
    const data = await response.json();
    expect(response.ok()).toBeTruthy();
    expect(data.pagination.pageSize).toBeLessThanOrEqual(10);
  });

  test('Экранирование при поиске', async ({ request }) => {
    const response = await requestWithRetry(request, 'get', `${process.env.API_URL}/customers?search=1+{}$()`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      }
    });
    expect(response.ok()).toBeTruthy();
  });

  test('Проверка роли (у пользователя отсутствует доступ к базе всех пользователей)', async ({ request }) => {
    const response = await requestWithRetry(request, 'get', `${process.env.API_URL}/customers`, {
      headers: {
        'Authorization': `Bearer ${process.env.USER_TOKEN}`
      }
    });

    expect(response.ok()).toBeFalsy();
    expect(response.status()).toEqual(403);
  });
});

test.describe('Проверка загрузки файлов', () => {
  test.afterEach(async () => {
    await new Promise(res => setTimeout(res, 3000));
  });

  test('Каталог для временных загрузок не должен отсутствовать', async () => {
    const workspace = process.env.GITHUB_WORKSPACE || path.resolve(process.cwd(), '..');
    const tempDir = path.join(
      workspace,
      'backend/src/public',
      process.env.UPLOAD_PATH_TEMP || 'temp',
    );

    expect(fs.existsSync(tempDir)).toBeTruthy();
  });

  test('Нельзя использовать оригинальное имя файла при формировании пути', async ({ request }) => {
    const imagePath = path.join(process.cwd(), 'data/mimage.png');
    const image = fs.readFileSync(imagePath);

    const response = await requestWithRetry(request, 'post', `${process.env.API_URL}/upload`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      },
      multipart: {
        file: {
          name: imagePath,
          mimeType: 'image/png',
          buffer: image
        }
      }
    });
    const data = await response.json();
    expect(response.ok()).toBeTruthy();
    expect(data.fileName).toBeDefined();

    const uploadedFileName = path.basename(data.fileName);
    const localFileName = path.basename(imagePath);

    expect(uploadedFileName).not.toEqual(localFileName);
  });

  test('Размер файлов должен быть лимитирован по минимуму (больше 2kb)', async ({ request }) => {
    const imagePath = path.join(process.cwd(), 'data/simage.png');
    const image = fs.readFileSync(imagePath);

    const response = await request.post(`${process.env.API_URL}/upload`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      },
      multipart: {
        file: {
          name: imagePath,
          mimeType: 'image/png',
          buffer: image
        }
      }
    });

    expect(response.ok()).toBeFalsy();
  });

  test('Размер файлов должен быть лимитирован по максимуму (меньше 10mb)', async ({ request }) => {
    const imagePath = path.join(process.cwd(), 'data/bimage.png');
    const image = fs.readFileSync(imagePath);

    const response = await request.post(`${process.env.API_URL}/upload`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      },
      multipart: {
        file: {
          name: imagePath,
          mimeType: 'image/png',
          buffer: image
        }
      }
    });

    expect(response.ok()).toBeFalsy();
  });

  test('Проверка метаданных загружаемого изображения', async ({ request }) => {
    const response = await request.post(`${process.env.API_URL}/upload`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      },
      multipart: {
        file: {
          name: 'image.png',
          mimeType: 'image/png',
          buffer: Buffer.alloc(1024 * 1024 * 5)
        }
      }
    });

    expect(response.ok()).toBeFalsy();
  });
});

test.describe('Общие проверки', () => {
  test.afterEach(async () => {
    await new Promise(res => setTimeout(res, 3000));
  });

  test('cors() содержит параметры и не пустой', async ({ request }) => {
    const response = await request.get(`${process.env.API_URL}/customers`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      }
    });
    expect(response.headers()).toHaveProperty('access-control-allow-origin', 'http://localhost:5173');
  });

  test('Лимит на размер body', async ({ request }) => {
    const response = await request.post(`${process.env.API_URL}/order`, {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      },
      data: {
        "address": "1".repeat(100000000),
        "payment": "online",
        "phone": '1',
        "total": 2200,
        "email": "maxim_91@inbox.ru",
        "items": ["66601a7857ecac94459696d0", "66601a8657ecac94459696d4"]
      }
    });

    expect(response.ok()).toBeFalsy();
    // expect(response.status()).toEqual(413);
  });

  test('Установлен рейт-лимит', async ({ request }) => {
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(request.get(`${process.env.API_URL}/customers`, {
        headers: {
          'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
        }
      }));
    }
    const responses = await Promise.all(promises)
    // console.log(responses.map(response => response.status()))
    expect(responses.every((response) => response.status() === 200)).toBeFalsy();
  });
});
