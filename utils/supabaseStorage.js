const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'produtos-imagens';

function getClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios.');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function uploadImagem(buffer, mimetype, nomeArquivo) {
  const supabase = getClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .upload(nomeArquivo, buffer, { contentType: mimetype, upsert: true });

  if (error) throw new Error('Erro ao fazer upload: ' + error.message);

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return urlData.publicUrl;
}

async function deletarImagem(urlPublica) {
  try {
    const supabase = getClient();
    const path = urlPublica.split(`/${BUCKET}/`)[1];
    if (path) await supabase.storage.from(BUCKET).remove([path]);
  } catch {
    // silencioso — não bloqueia operação principal
  }
}

module.exports = { uploadImagem, deletarImagem };
