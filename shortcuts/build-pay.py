# Builds "Friendly Pay" (v3). Input is JSON from Friendly:
#   {"to": "+12145551234", "amt": 9.65, "note": "White Box Roastery Co. · Friendly", "vcf": "BEGIN:VCARD ... END:VCARD"}
# 1. Reads the four values.
# 2. Turns the vCard text into a contact (a .vcf file -> Get Contacts from Input), so Apple's payment sheet can show
#    the person's name instead of a bare number.
# 3. Send Payment (identifier is.workflow.actions.venmo.pay; Apple Pay / Apple Cash is the default app) to that
#    contact, or to the number when the contact couldn't be made, with the amount filled in as a currency quantity
#    (WFQuantityFieldValue, Magnitude = the Amount variable coerced to a number, Unit USD). v1 passed the amount as
#    text and Shortcuts asked for it again.
# 4. Opens Friendly again. Apple still shows its own sheet and asks for Face ID; nothing is ever sent silently.
import plistlib, uuid, sys
U = lambda: str(uuid.uuid4()).upper()
u_dict, u_to, u_amt, u_note, u_vcf, u_file, u_contacts, g_if = U(), U(), U(), U(), U(), U(), U(), U()
ref = lambda uid, name, **extra: {"OutputUUID": uid, "Type": "ActionOutput", "OutputName": name, **extra}
att = lambda r: {"Value": r, "WFSerializationType": "WFTextTokenAttachment"}
tok = lambda parts: {"Value": {"string": "".join("￼" if isinstance(p, dict) else p for p in parts),
    "attachmentsByRange": {f"{{{sum(1 if isinstance(q, dict) else len(q) for q in parts[:i])}, 1}}": p for i, p in enumerate(parts) if isinstance(p, dict)}},
    "WFSerializationType": "WFTextTokenString"}
A = lambda ident, **p: {"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": p}
amount = {"Value": {"Magnitude": ref(u_amt, "Amount", Aggrandizements=[{"Type": "WFCoercionVariableAggrandizement", "CoercionItemClass": "WFNumberContentItem"}]), "Unit": "USD"},
          "WFSerializationType": "WFQuantityFieldValue"}
pay = lambda recipients: A("is.workflow.actions.venmo.pay", UUID=U(), ShowWhenRun=True, WFVenmoActionRecipients=recipients,
                           WFVenmoActionAmount=amount, WFVenmoActionNote=tok([ref(u_note, "Note")]))
# v3: the contact-card steps (Set Name -> Get Contacts -> If) made v2 fail with "There was a problem running the
# shortcut", so they're out; the person goes in as their number, as in v1 (which ran), and only the amount format
# changed from v1.
acts = [
  A("is.workflow.actions.detect.dictionary", UUID=u_dict, WFInput={"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"}),
  A("is.workflow.actions.getvalueforkey", UUID=u_to, CustomOutputName="Number", WFDictionaryKey="to", WFInput=att(ref(u_dict, "Dictionary"))),
  A("is.workflow.actions.getvalueforkey", UUID=u_amt, CustomOutputName="Amount", WFDictionaryKey="amt", WFInput=att(ref(u_dict, "Dictionary"))),
  A("is.workflow.actions.getvalueforkey", UUID=u_note, CustomOutputName="Note", WFDictionaryKey="note", WFInput=att(ref(u_dict, "Dictionary"))),
  pay(att(ref(u_to, "Number"))),
  A("is.workflow.actions.openapp", WFAppIdentifier="com.officialfriendly.app",
    WFSelectedApp={"BundleIdentifier": "com.officialfriendly.app", "Name": "Friendly", "TeamIdentifier": "L7H9872BR2"}),
]
wf = {"WFWorkflowClientVersion": "2607.0.2", "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
  "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59446},
  "WFWorkflowImportQuestions": [], "WFWorkflowTypes": [], "WFQuickActionSurfaces": [],
  "WFWorkflowInputContentItemClasses": ["WFStringContentItem"], "WFWorkflowHasShortcutInputVariables": True,
  "WFWorkflowOutputContentItemClasses": [], "WFWorkflowHasOutputFallback": False, "WFWorkflowActions": acts}
plistlib.dump(wf, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)
print("wrote", sys.argv[1], len(acts), "actions")
