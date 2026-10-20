"""Preparo do tokenizador sem rede nem dependências dos modelos."""
import sys
import unittest
from unittest.mock import Mock, patch

from prepare_nltk import prepare_punkt, validate_punkt


class PreparePunktTest(unittest.TestCase):
    def setUp(self):
        self.nltk = Mock()
        self.nltk.data.path = []
        self.tokenizer = self.nltk.data.load.return_value
        self.tokenizer.tokenize.return_value = ["Olá, mundo.", "Esta é outra frase."]
        self.modules = patch.dict(sys.modules, {"nltk": self.nltk})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def test_existing_portuguese_data_needs_no_network(self):
        prepare_punkt()
        self.nltk.download.assert_not_called()
        self.nltk.data.load.assert_called_with("tokenizers/punkt_tab/portuguese.pickle")

    def test_missing_data_is_downloaded_and_loaded_again(self):
        self.nltk.data.load.side_effect = [LookupError("punkt_tab ausente"), self.tokenizer]
        self.nltk.download.return_value = True
        prepare_punkt("/shared/nltk_data")
        self.nltk.download.assert_called_once_with(
            "punkt_tab", download_dir="/shared/nltk_data", quiet=True, raise_on_error=True
        )
        self.assertEqual(self.nltk.data.load.call_count, 2)

    def test_failed_download_aborts_preparation(self):
        self.nltk.data.load.side_effect = LookupError("punkt_tab ausente")
        self.nltk.download.return_value = False
        with self.assertRaisesRegex(RuntimeError, "punkt_tab"):
            prepare_punkt()

    def test_successful_download_must_still_be_readable(self):
        self.nltk.data.load.side_effect = LookupError("punkt_tab fora do caminho")
        self.nltk.download.return_value = True
        with self.assertRaises(LookupError):
            prepare_punkt()

    def test_check_never_downloads_missing_data(self):
        self.nltk.data.load.side_effect = LookupError("punkt_tab ausente")
        with self.assertRaises(LookupError):
            validate_punkt()
        self.nltk.download.assert_not_called()

    def test_loaded_tokenizer_must_split_portuguese_sentences(self):
        self.tokenizer.tokenize.return_value = ["Olá, mundo. Esta é outra frase."]
        with self.assertRaisesRegex(RuntimeError, "português"):
            validate_punkt()


if __name__ == "__main__":
    unittest.main()
