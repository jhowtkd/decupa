/**
 * Grava ~/.decupa/credentials a partir do ambiente da máquina.
 * Não imprime a chave. Não sobrescreve arquivo existente.
 */
import { homedir } from "node:os";
import { installCompanyCredentials } from "../packages/triage/src/company-credentials.ts";

const result = await installCompanyCredentials(homedir(), process.env);
if (result.status === "installed") {
  console.log("Credencial da empresa gravada em ~/.decupa/credentials (só este usuário). Formulário da primeira abertura pulado.");
} else if (result.status === "skipped") {
  console.log("Credencial já existia; nenhuma chave foi sobrescrita.");
} else {
  console.log("Nenhuma chave de empresa no ambiente. Defina DECUPA_COMPANY_API_KEY (preset opcional DECUPA_COMPANY_PRESET) e, para o Jev, TYPESAFE_API_KEY — ou ZAI_API_KEY / GEMINI_API_KEY / MINIMAX_API_KEY — antes do setup para pular o formulário.");
}
