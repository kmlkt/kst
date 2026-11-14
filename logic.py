from dtos import Error_Dto, Parameter_Dto
from meta import ParameterMeta, PARAMETERS_META
from models import Device, Parameter


def check_parameter(device: Device, parameter: Parameter) -> Parameter_Dto:
    meta = PARAMETERS_META[device.model][parameter.parameter]
    state = 'normal'
    norm = ''
    operator = ''

    if meta.minimum_warning is not None and parameter.value < meta.minimum_warning:
        state = 'warning'
        operator = '≥'
        norm = meta.minimum_warning
        if meta.minimum is not None and parameter.value < meta.minimum:
            state = 'error'
            norm = meta.minimum
    elif meta.maximum_warning is not None and parameter.value > meta.maximum_warning:
        state = 'warning'
        operator = '≤'
        norm = meta.maximum_warning
        if meta.maximum is not None and parameter.value > meta.maximum:
            state = 'error'
            norm = meta.maximum

    return Parameter_Dto(
        parameter=parameter.parameter,
        value=f"{parameter.value:.2f}".rstrip("0").rstrip("."),
        unit = meta.unit,
        state=state,
        norm=f"{norm:.2f}".rstrip("0").rstrip(".") if norm != "" and norm != None else "",
        operator=operator
    )



def find_errors(device: Device, parameters: list[Parameter]) -> list[Error_Dto]:
    params = {x.parameter: x.value for x in parameters}
    meta = PARAMETERS_META[device.model]

    def exists(p: str):
        return p in params and p in meta

    def too_low(p: str):
        return exists(p) and meta[p].minimum is not None and params[p] < meta[p].minimum
    
    def too_high(p: str):
        return exists(p) and meta[p].maximum is not None and params[p] > meta[p].maximum
    
    def is_normal(p: str):
        return not too_high(p) and not too_low(p)
    
    errors: list[Error_Dto] = []

    if too_high("Вибрация широкополосная") and too_high("Температура вала") and is_normal("Ток вала"):
        errors.append(Error_Dto(
            code="smaz", 
            label="Проблема со смазкой подшипников или их металлический износ",
            advice="Проверить систему смазки, при необходимости добавить/заменить самзку. Запланировать замену подшипника"
            ),
        )

    if too_high("Вибрация широкополосная") and too_low("Давление на входе"):
        errors.append(Error_Dto(
            code="kavit", 
            label="Кавитация",
            advice="Немедленно проверить условия всасывания. Кавитация разрушает рабочее колесо"
            ),
        )

    if too_high("Вибрация на удвоенной частоте") and too_high("Ток вала") and is_normal("Температура вала"):
        errors.append(Error_Dto(
            code="rascentr", 
            label="Расцентровка валов (соосность нарушена)",
            advice="Выполнить проверку и коррекцию соосности насоса и двигателя лазерным методом"
            ),
        )

    if too_low("КПД проточной части") and is_normal("Вибрация широкополосная") and is_normal("Температура вала"):
        errors.append(Error_Dto(
            code="iznos", 
            label="Внутренний износ проточной части (без критических механических повреждений)",
            advice="Плановый ремонт. Заказать запасные части (рабочее колесо, уплотнительные кольца) для следующего планового останова."
            ),
        )

    if too_high("Наработка насоса"):
        errors.append(Error_Dto(
            code="interval", 
            label="Достигнут регламентный межремонтный интервал",
            advice="Провести ТО-2: замена масла в подшипниковых узлах"
            ),
        )

    # TODO
    if too_high("Вибрация подшипникового узла") and too_high("Температура подшипникового узла"):
        errors.append(Error_Dto(
            code="leakage", 
            label="Утечка с сопутствующим перегревом узла",
            advice="Немедленно перевести насос в резерв"
            ),
        )

    #TODO
    if too_high("Вибрация низкочастотная"):
        errors.append(Error_Dto(
            code="looseness", 
            label="Вибрация вызвана ослаблением посадки",
            advice="Протянуть болты и выполнить проверку соосности"
            ),
        )

    if too_low("Уровень масла") and too_high("Температура подшипникового узла"):
        errors.append(Error_Dto(
            code="oil", 
            label="Свойства масла ухудшены, что вызывает перегрев",
            advice="Запланировать замену масла и промывку подшипникового щита в течение 48 часов"
            ),
        )

    if too_high("Дисбаланс токов по фазам") and too_high("Температура клеммной коробки"):
        errors.append(Error_Dto(
            code="current", 
            label="Критический нагрев силового соединения. Риск отгорания фазы или возгорания",
            advice="Немедленно обесточить и протянуть клеммы"
            ),
        )

    return errors