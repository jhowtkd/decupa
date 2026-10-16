# Importação direta do Google Drive

Cole o link de um arquivo do Drive na gaveta de Novo Projeto e a VPS baixa direto do Google, valida e publica no acervo local. O navegador só acompanha o progresso — quem trafega os bytes é a conexão datacenter ↔ datacenter, sem passar pela máquina de quem importa.

## 1. Compartilhar o arquivo

No Drive, compartilhe o arquivo como **Qualquer pessoa com o link – Leitor**. Pastas não são suportadas: abra o arquivo e copie o link dele. Documentos nativos do Google (Docs, Planilhas, Apresentações) não podem ser importados; exporte como vídeo ou áudio.

Formatos de link aceitos:

- `https://drive.google.com/file/d/ID_DO_ARQUIVO/view`
- `https://drive.google.com/open?id=ID_DO_ARQUIVO`
- o ID puro do arquivo

## 2. Criar a API key

No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto (ex. `decupa-drive-import`) e ative a **Google Drive API** em APIs & Services → Library. Depois, em APIs & Services → Credentials, crie uma **API key** e restrinja:

- **API restrictions**: somente Google Drive API.
- **Application restrictions → IP addresses**: o IP público da VPS.

Sem OAuth e sem verificação de app: a chave só lê arquivos com link público. Não cole a chave em chats, commits ou capturas.

## 3. Configurar a VPS

Na versão que contém esta integração, edite `/home/jhonatan/decupa/.env` na VPS e preencha:

```dotenv
DECUPA_DRIVE_API_KEY=sua_chave
```

Preserve as demais configurações do `.env`. Restrinja o arquivo com `chmod 600 .env`. Com o código já atualizado no diretório de produção, reconstrua apenas o app:

```bash
cd /home/jhonatan/decupa
sudo docker compose up -d --build decupa
```

Sem a chave, o campo do Drive fica escondido na interface e a API responde 503. A importação do Drive é independente do [upload pelo R2](upload-r2.md): um, outro ou ambos podem estar ativos.

## 4. Conferir o fluxo real

1. Compartilhe um vídeo pequeno e cole o link na gaveta de Novo Projeto.
2. O item mostra "Importando · %" com o progresso do download na VPS.
3. Ao terminar, a mídia aparece no acervo e funciona no projeto. Importar o mesmo conteúdo duas vezes reaproveita a mídia (deduplicado).
4. Repita com um arquivo grande e meça o tempo. O download continua no servidor mesmo se a aba fechar; reabrir e colar o mesmo link reanexa pelo progresso salvo.

## Retomada e falhas

- O download usa Range e retoma do byte confirmado após queda de rede; "Tentar de novo" repete sem baixar tudo outra vez.
- Tamanho, MD5 do Drive, SHA-256 e ffprobe são conferidos antes de publicar. Divergência de integridade (422) descarta o parcial e bloqueia retry: escolha outro arquivo.
- Cota do Google excedida (503) pede nova tentativa mais tarde. Arquivo sem link público responde 404 com a orientação.
- Remover o item cancela a importação no servidor e apaga o parcial. O arquivo original no Drive nunca é alterado.
- Falha de validação (mídia ilegível) mantém o estado para leitura do erro até o TTL de uploads (24 horas por padrão); downloads parados expiram e liberam o parcial.

Referências: [Drive API files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get), [download de arquivos](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [restringir chaves de API](https://cloud.google.com/docs/authentication/api-keys#securing_an_api_key).
