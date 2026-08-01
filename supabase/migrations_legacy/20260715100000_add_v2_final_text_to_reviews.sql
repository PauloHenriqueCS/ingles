-- Adiciona coluna para armazenar a versão final corrigida pela IA da segunda versão do aluno.
-- Mantém separadas: original_text, corrected_text (V1 AI), version_2_text (aluno), version_2_final_text (V2 AI).

ALTER TABLE english_reviews
  ADD COLUMN version_2_final_text TEXT;
