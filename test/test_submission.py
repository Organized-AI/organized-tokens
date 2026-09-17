import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('tokens',Path(__file__).resolve().parents[1]/'public/tokens.py')
tokens=importlib.util.module_from_spec(spec)
spec.loader.exec_module(tokens)

class SubmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.report=Path(self.tmp.name)/'profile.html'
        self.profile={'schema_version':9,'prompt_version':8,'name':'Synthetic example','work_arcs':[]}
        self.report.write_text('<script type="application/json" id="profile-data">'+json.dumps(self.profile)+'</script>')
        self.creds={'token':'test-only','handle':'example'}

    def test_typed_consent_selects_public_or_private(self):
        for choice,visibility in [('share','public'),('keep','private')]:
            with self.subTest(choice=choice), patch.object(tokens,'load_creds',return_value=self.creds), patch('builtins.input',return_value=choice), patch.object(tokens,'http',return_value=(201,{'snapshot_seq':1})) as send, redirect_stdout(io.StringIO()):
                self.assertEqual(tokens.cmd_submit([str(self.report)]),0)
                self.assertEqual(send.call_args.args[:3],('POST','/api/assessment?visibility='+visibility,self.profile))

    def test_cancellation_never_sends(self):
        with patch.object(tokens,'load_creds',return_value=self.creds), patch('builtins.input',return_value=''), patch.object(tokens,'http') as send, redirect_stdout(io.StringIO()):
            self.assertEqual(tokens.cmd_submit([str(self.report)]),1)
            send.assert_not_called()

    def test_nonobject_payload_is_rejected(self):
        self.report.write_text('<script type="application/json" id="profile-data">[]</script>')
        self.assertIsNone(tokens.extract_profile(str(self.report)))

    def test_failed_removal_keeps_credentials_for_retry(self):
        with patch.object(tokens,'load_creds',return_value=self.creds), patch.object(tokens,'http',return_value=(503,{'error':'unavailable'})), patch.object(tokens.os,'remove') as remove, redirect_stdout(io.StringIO()):
            self.assertEqual(tokens.cmd_leave(),1)
            remove.assert_not_called()

if __name__=='__main__':unittest.main()
