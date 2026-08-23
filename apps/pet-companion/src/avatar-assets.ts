const DATABASE = 'dsh-pet-assets'
const STORE = 'avatar-assets'

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveAvatarAsset(file: File) {
  const db = await database()
  const id = `avatar-${Date.now()}-${crypto.randomUUID()}`
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(file, id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
  return id
}

export async function loadAvatarAsset(id: string): Promise<Blob | undefined> {
  if (!id) return undefined
  const db = await database()
  const asset = await new Promise<Blob | undefined>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(id)
    request.onsuccess = () => resolve(request.result as Blob | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return asset
}
