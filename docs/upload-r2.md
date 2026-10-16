# Upload pelo R2 como passagem

O navegador envia o arquivo diretamente para um bucket privado do Cloudflare R2. A VPS baixa o objeto em fluxo, confere o tamanho, calcula o SHA-256 e valida a mídia com ffprobe. Depois de publicar a mídia no acervo local, apaga a cópia no R2. A aplicação e o acervo continuam na VPS, com acesso pelo Tailscale.

O SHA-256 identifica o conteúdo importado. Quando a API recebe um `sha256` original, também o compara. O cliente de upload atual não calcula o hash original no navegador; a transmissão usa HTTPS e a importação exige o tamanho informado. O ETag multipart não é um hash SHA-256 do arquivo.

## 1. Criar o bucket e as credenciais

No painel Cloudflare, entre em **Storage & databases → R2 Object Storage**. Ative o R2 se necessário (pode exigir cadastro de pagamento) e crie um bucket, por exemplo `decupa-upload-passagem`, na classe **Standard**. A localização automática é suficiente. Mantenha desativados o acesso público `r2.dev` e domínios públicos do bucket.

Em **Manage R2 API Tokens**, crie credenciais com **Object Read & Write**, limitadas a esse bucket. Anote o **Account ID**, o **Access Key ID** e o **Secret Access Key**. São credenciais S3 do R2; o token da API geral da Cloudflare não substitui essas chaves.

## 2. Permitir upload do navegador (CORS)

No bucket, abra **Settings → CORS policy** e salve:

```json
[
  {
    "AllowedOrigins": ["https://decupa.tailc15816.ts.net"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

Se o endereço do app mudar, acrescente a origem exata com protocolo e porta, sem caminho ou barra final. Não é necessário liberar `*`, tornar o bucket público ou expor ETag: o servidor consulta as partes diretamente pela API S3.

## 3. Configurar a VPS

Na versão que contém esta integração, edite `/home/jhonatan/decupa/.env` na VPS e preencha as quatro variáveis:

```dotenv
DECUPA_R2_ACCOUNT_ID=seu_account_id
DECUPA_R2_BUCKET=decupa-upload-passagem
DECUPA_R2_ACCESS_KEY_ID=sua_access_key
DECUPA_R2_SECRET_ACCESS_KEY=sua_secret_key
```

Não cole as chaves em chats, commits ou capturas. Preserve as demais configurações do `.env`. Restrinja o arquivo com `chmod 600 .env`. Com o código já atualizado no diretório de produção, reconstrua apenas o app:

```bash
cd /home/jhonatan/decupa
sudo docker compose up -d --build decupa
```

As quatro variáveis vazias mantêm o upload local. Configuração parcial impede a inicialização com uma mensagem clara. Envios locais iniciados antes da ativação continuam retomáveis. Para retomar um envio R2, suas credenciais e o mesmo bucket devem continuar configurados.

## 4. Conferir o fluxo real

1. Abra o Decupa pelo endereço Tailscale e envie uma mídia pequena válida.
2. Na aba Network do navegador, os corpos das partes devem ir em `PUT` para `*.r2.cloudflarestorage.com`. Só as requisições de controle passam por `/api/uploads` na VPS.
3. A interface passa de “Enviando” para “Importando” e depois “Pronto”. O arquivo deve aparecer no acervo e funcionar no projeto.
4. No bucket, o objeto `decupa-staging/<id-do-envio>` deve desaparecer depois da importação. Se a exclusão falhar, a mídia continua disponível localmente e a VPS repete a limpeza periodicamente e após reiniciar.
5. Repita com o arquivo de 400 MB e meça o tempo até “Pronto”. A integração sozinha não comprova que a rota real ficou mais rápida.

## Retomada e falhas

- Partes de 20 MiB por padrão, uma por vez. A pausa aborta a parte em voo; a retomada consulta o que o R2 realmente recebeu. URLs de partes expiram em 15 minutos e novas tentativas obtêm novas URLs.
- Depois de concluir o objeto, a importação continua no servidor mesmo se a aba fechar. Reselecionar o mesmo arquivo permite recuperar o resultado.
- Falha de rede, falta de espaço ou mídia inválida preservam o objeto completo no R2. Tentar novamente repete a importação, sem reenviar o arquivo. Remover/cancelar explicitamente o envio autoriza apagar sua cópia temporária.
- Envios multipart abandonados são abortados após o TTL de uploads (24 horas por padrão). Para cobrir quedas antes da persistência da sessão, mantenha também uma regra do bucket para **abortar uploads multipart incompletos após 7 dias** (padrão do R2).
- Não configure uma regra geral para excluir objetos completos: ela poderia apagar um arquivo que a VPS ainda não conseguiu validar. Objetos completos com importação malsucedida ficam preservados até nova tentativa ou cancelamento.
- Desativar R2 não interrompe o acervo já importado. Preserve as credenciais até terminar importações e limpezas pendentes.

Referências: [URLs temporárias](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [multipart e retomada](https://developers.cloudflare.com/r2/objects/upload-objects/), [CORS](https://developers.cloudflare.com/r2/buckets/cors/), [ciclo de vida](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).
