import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

const BUCKET = 'bt-files'

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|heic)$/i

function isImage(filename) {
  return IMAGE_EXTENSIONS.test(filename)
}

export default function FileModal({ order, onClose, allowUpload = false }) {
  const [files, setFiles] = useState([])
  const [previews, setPreviews] = useState({}) // file id -> signed url
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)

  async function loadFiles() {
    setLoading(true)
    const { data } = await supabase
      .from('bt_files')
      .select('id, filename, storage_path, uploaded_at')
      .eq('order_id', order.id)
      .order('uploaded_at', { ascending: false })
    const rows = data ?? []
    setFiles(rows)
    setLoading(false)
    loadPreviews(rows)
  }

  // Screenshots and photos render in place — a tag's damage photo is worth
  // more at a glance than a filename you have to tap through to see. Signed
  // in one batch so a tag with a dozen photos is still a single request.
  async function loadPreviews(rows) {
    const images = rows.filter((f) => isImage(f.filename))
    if (images.length === 0) return
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrls(images.map((f) => f.storage_path), 3600)
    if (error || !data) return
    const urls = {}
    data.forEach((entry, i) => {
      if (entry.signedUrl) urls[images[i].id] = entry.signedUrl
    })
    setPreviews((prev) => ({ ...prev, ...urls }))
  }

  useEffect(() => {
    loadFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id])

  async function handleOpen(file) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(file.storage_path, 60)
    if (!error && data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const path = `${order.tag_name}/${Date.now()}_${file.name}`
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file)
    if (!uploadError) {
      const { data: userData } = await supabase.auth.getUser()
      await supabase.from('bt_files').insert({
        order_id: order.id,
        filename: file.name,
        storage_path: path,
        uploaded_by: userData?.user?.id,
      })
      await loadFiles()
    }
    setUploading(false)
  }

  return (
    <div className="fixed inset-0 bg-charcoal/60 flex items-end sm:items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-paper w-full sm:max-w-md max-h-[80vh] overflow-y-auto border-t-4 border-safety"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 bg-charcoal">
          <h2 className="font-display text-2xl font-bold text-paper tracking-wide">{order.tag_name}</h2>
          <button onClick={onClose} className="text-steelLight text-sm hover:text-paper">
            Close
          </button>
        </div>

        <div className="p-5">
          {loading && <p className="text-sm text-steelLight">Loading files…</p>}
          {!loading && files.length === 0 && (
            <p className="text-sm text-steelLight">No files attached to this tag yet.</p>
          )}
          <ul className="space-y-2">
            {files.map((f) => (
              <li key={f.id}>
                <button
                  onClick={() => handleOpen(f)}
                  className="w-full text-left bg-white border border-paperDim text-sm text-andonBlue font-medium"
                >
                  {previews[f.id] && (
                    <img
                      src={previews[f.id]}
                      alt={f.filename}
                      loading="lazy"
                      className="w-full max-h-64 object-contain bg-paperDim border-b border-paperDim"
                    />
                  )}
                  <span className="block px-3 py-2">{f.filename}</span>
                </button>
              </li>
            ))}
          </ul>

          {allowUpload && (
            <div className="mt-4 pt-4 border-t border-paperDim">
              <label className="block text-sm text-steelLight mb-2">Attach a file to this tag</label>
              <input type="file" onChange={handleUpload} disabled={uploading} className="text-sm" />
              {uploading && <p className="text-xs text-steelLight mt-1">Uploading…</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
